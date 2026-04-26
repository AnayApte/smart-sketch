"""
SmartSketch LiveKit Agent
=========================

This is a Python program that runs on a server (or your computer) and does the following:

1. CONNECTS to a LiveKit room (the same room your student's browser connects to)
2. LISTENS to the audio being streamed (the professor's voice)
3. TRANSCRIBES the audio using Deepgram (speech → text)
4. BATCHES transcripts every 30 seconds
5. SENDS transcripts to Gemini to extract key concepts
6. SENDS the concepts back to your React app via Data Channel

Think of this agent as an invisible participant in the room who's really good at
taking notes and organizing them into concepts.

HOW IT WORKS:
-------------
- LiveKit is like a video call platform (Zoom, but for developers)
- When a student opens your app and starts recording, they create a "room"
- This agent automatically joins that room when it detects a new one
- The agent subscribes to the audio track (listens to the mic)
- Audio frames are sent to Deepgram in real-time
- Deepgram returns text as people speak
- Every 30 seconds, we take all the text and ask Gemini to find key concepts
- Those concepts get sent to your React app to update the mind map

TO RUN THIS:
------------
1. Install dependencies: pip install -r requirements.txt
2. Set environment variables (see .env.example)
3. Run: python main.py dev

The "dev" mode means it will automatically join any new rooms created on your LiveKit project.
"""

import asyncio
import json
import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional

# Load environment variables from .env file
# This MUST happen before importing LiveKit plugins that need API keys
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env")

# LiveKit imports - these are the libraries that connect to LiveKit
from livekit import rtc
from livekit.agents import (
    AutoSubscribe,
    JobContext,
    JobProcess,
    WorkerOptions,
    cli,
)
from livekit.agents.stt import SpeechEvent, SpeechEventType
from livekit.plugins import deepgram
import google.generativeai as genai

# How often to batch transcripts and extract concepts (in seconds)
BATCH_INTERVAL_SECONDS = 5

_DEFAULT_GEMINI_PRIMARY = "gemini-2.0-flash"
# When GEMINI_MODEL_CHAIN / GEMINI_MODEL_FALLBACKS are unset, try these after the primary (same order as Next.js `gemini-fallback.ts`).
_FREE_TIER_MODEL_TAIL = [
    "gemini-2.5-flash",
    "gemini-3-flash",
    "gemini-3.1-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
]

def _dedupe_models(models: List[str]) -> List[str]:
    seen = set()
    out: List[str] = []
    for m in models:
        if not m or m in seen:
            continue
        seen.add(m)
        out.append(m)
    return out


def _parse_comma_models(raw: str) -> List[str]:
    return [p.strip() for p in raw.split(",") if p.strip()]


def gemini_model_chain() -> List[str]:
    chain_env = os.getenv("GEMINI_MODEL_CHAIN", "").strip()
    if chain_env:
        return _dedupe_models(_parse_comma_models(chain_env))
    primary = os.getenv("GEMINI_MODEL", _DEFAULT_GEMINI_PRIMARY).strip() or _DEFAULT_GEMINI_PRIMARY
    extra_raw = os.getenv("GEMINI_MODEL_FALLBACKS", "").strip()
    extra = _parse_comma_models(extra_raw) if extra_raw else []
    tail = [m for m in _FREE_TIER_MODEL_TAIL if m != primary and m not in extra]
    return _dedupe_models([primary, *extra, *tail])


def _is_gemini_quota_or_rate_limit(exc: BaseException) -> bool:
    msg = str(exc).lower()
    if any(
        k in msg
        for k in (
            "resource_exhausted",
            "resource exhausted",
            "quota",
            "rate limit",
            "too many requests",
            "service unavailable",
            "high demand",
        )
    ):
        return True
    if "429" in msg or "503" in msg:
        return True
    try:
        from google.api_core import exceptions as google_exc

        return isinstance(
            exc,
            (
                google_exc.ResourceExhausted,
                google_exc.TooManyRequests,
                google_exc.ServiceUnavailable,
            ),
        )
    except ImportError:
        return False


class TranscriptProcessor:
    """
    This class collects transcript pieces and processes them in batches.

    Why batch? Because:
    - We don't want to call Gemini for every single word
    - 30 seconds of lecture content gives enough context for meaningful concepts
    - It reduces API costs and provides better concept extraction
    """

    def __init__(self, room: rtc.Room):
        # The LiveKit room we're connected to
        self.room = room

        # Buffer to collect transcript pieces
        # Example: ["Hello class", "today we discuss", "photosynthesis"]
        self.transcript_buffer: List[str] = []

        # Full transcript for the entire session (for later review)
        self.full_transcript: List[str] = []

        # Track when we last processed a batch
        self.last_batch_time = datetime.now()
        
        # Track if a batch is currently being processed to avoid race conditions
        self.is_processing = False

    def add_transcript(self, text: str):
        """
        Called every time Deepgram returns some transcribed text.
        We add it to our buffer and check if time to process.
        """
        if not text.strip():
            return

        self.transcript_buffer.append(text)
        self.full_transcript.append(text)
        # Publish finalized transcript chunks immediately so UI is not blocked by
        # concept extraction/model latency.
        asyncio.create_task(self.send_transcript_update(text))
        
        buffer_length = sum(len(t) for t in self.transcript_buffer)
        print(f"[TRANSCRIPT ADDED] '{text}' - buffer now has {buffer_length} chars, is_processing={self.is_processing}")

        # Check if it's time to process a batch
        # Only trigger if not already processing to avoid race conditions
        if self.is_processing:
            print(f"[BATCH] Skipping trigger - already processing")
            return
            
        time_since_last_batch = (datetime.now() - self.last_batch_time).total_seconds()
        
        # Process when either:
        # 1. We have enough time passed (BATCH_INTERVAL_SECONDS) with some content
        # 2. We have a reasonable amount of text accumulated (>200 chars - reduced from 300)
        should_process = (time_since_last_batch >= BATCH_INTERVAL_SECONDS and buffer_length > 20) or buffer_length > 200
        
        if should_process:
            print(f"[BATCH] Triggered: time={time_since_last_batch:.1f}s, length={buffer_length} chars")
            # Schedule the batch processing (don't block the transcript collection)
            asyncio.create_task(self.process_batch())
        else:
            print(f"[BATCH] Not ready: time={time_since_last_batch:.1f}s (need {BATCH_INTERVAL_SECONDS}s), length={buffer_length} chars")

    async def send_transcript_update(self, transcript: str):
        """Sends a transcript-only update to the frontend immediately."""
        message = {
            "type": "transcript",
            "data": {
                "transcript": transcript,
                "timestamp": datetime.now().isoformat(),
            },
        }

        message_bytes = json.dumps(message).encode("utf-8")
        await self.room.local_participant.publish_data(
            message_bytes,
            reliable=True,
            topic="smartsketch",
        )

    async def process_batch(self):
        """
        Takes all the transcript pieces collected in the last 5 seconds,
        combines them, sends to Gemini for concept extraction, and
        sends the results back to the React app.
        """
        # Set flag to prevent duplicate batches
        self.is_processing = True
        print(f"[BATCH] Starting process_batch - buffer has {sum(len(t) for t in self.transcript_buffer)} chars")
        
        try:
            if not self.transcript_buffer:
                print(f"[BATCH] Buffer is empty, skipping")
                return

            # Combine all transcript pieces into one string
            # Example: "Hello class today we discuss photosynthesis"
            batch_text = " ".join(self.transcript_buffer)

            # Clear the buffer for the next batch
            self.transcript_buffer = []
            self.last_batch_time = datetime.now()

            print(f"[BATCH] Processing {len(batch_text)} characters of transcript: {batch_text[:100]}...")

            # Ask Gemini to extract concepts from the transcript
            concepts = await self.extract_concepts(batch_text)
            print(f"[BATCH] Gemini returned {len(concepts)} concepts")

            # Send concepts back to the React app via Data Channel
            await self.send_to_frontend(concepts)
            
            print(f"[BATCH] Completed - extracted {len(concepts)} concepts")

        except Exception as e:
            print(f"[ERROR] Failed to process batch: {e}")
            import traceback
            traceback.print_exc()
        finally:
            # Always reset the flag
            self.is_processing = False
            print(f"[BATCH] Completed, is_processing reset to False")

    async def extract_concepts(self, transcript: str) -> List[dict]:
        """
        Sends the transcript to Gemini and asks it to extract key concepts
        with rich hierarchical parent-child relationships for complex mind maps.

        Returns a list of concepts with proper parent-child relationships where:
        - Multiple main topics can exist independently
        - Concepts can branch off other concepts (not just main topics)
        - Details can connect to any level
        - Creates a true tree structure rather than a flat fan

        Example:
        [
            {"id": "c1", "label": "Photosynthesis", "type": "main", "explanation": "...", "parent": null},
            {"id": "c2", "label": "Light Reactions", "type": "concept", "explanation": "...", "parent": "c1"},
            {"id": "c3", "label": "Dark Reactions", "type": "concept", "explanation": "...", "parent": "c1"},
            {"id": "c4", "label": "Chlorophyll", "type": "detail", "explanation": "...", "parent": "c2"},
            {"id": "c5", "label": "Calvin Cycle", "type": "detail", "explanation": "...", "parent": "c3"},
            {"id": "c6", "label": "CO2 Fixation", "type": "detail", "explanation": "...", "parent": "c5"}
        ]
        """

        # The prompt that tells the model what to do
        prompt = f"""You are an expert educational assistant creating a RICH HIERARCHICAL concept map from a lecture transcript.

Your task: Extract key concepts and organize them into a complex tree structure showing how ideas relate to each other.
NOT a simple flat diagram - create REAL depth with branches from branches.

CRITICAL RULES:
1. Identify the MAIN TOPIC(S) - these are broad subjects with no parent
2. Create MULTIPLE LEVELS of supporting concepts (not just 2 levels)
3. Concepts should branch off OTHER CONCEPTS when that's the real relationship
4. Build a TRUE TREE structure with meaningful hierarchies
5. Each concept MUST have a unique "id" (c1, c2, c3, etc.)
6. Each concept (except main topics) MUST have a "parent" field pointing to its actual parent's id
7. Main topics have "parent": null

Each concept must have:
- "id": Unique identifier (c1, c2, c3...)
- "label": Specific term (1-4 words) - domain terms, not generic words
- "type": "main" (core topic), "concept" (intermediate idea), or "detail" (specific fact/example)
- "explanation": Clear 1-2 sentence explanation of what this is
- "parent": Parent concept's id (or null if main topic)

CRITICAL - CREATE DEPTH:
- If Light Reactions contains Electron Transport, make Electron Transport the parent of specific proteins
- If Calvin Cycle has phases, those phases should branch from it
- Build multiple levels: Main → Sub-concepts → Details → Sub-details
- Don't limit to just 3 levels - go deeper when appropriate

EXAMPLES OF GOOD STRUCTURE:
- Photosynthesis (main)
  - Light Reactions (concept, parent=Photosynthesis)
    - Electron Transport (detail, parent=Light Reactions)
      - ATP Synthase (detail, parent=Electron Transport)
    - Thylakoid (detail, parent=Light Reactions)

QUALITY REQUIREMENTS:
- Extract 4-8 concepts per batch for good complexity
- Focus on DOMAIN-SPECIFIC terms (formulas, equipment, named processes)
- Avoid generic words unless they are the actual topic
- Create meaningful connections showing HOW concepts relate
- If concept A is part of concept B, then A's parent is B

Return ONLY valid JSON array with no markdown formatting:
[
  {{"id": "c1", "label": "Photosynthesis", "type": "main", "explanation": "Process by which plants convert light into chemical energy stored in glucose", "parent": null}},
  {{"id": "c2", "label": "Light-Dependent Reactions", "type": "concept", "explanation": "Reactions in thylakoid membrane that capture light energy and produce ATP and NADPH", "parent": "c1"}},
  {{"id": "c3", "label": "Electron Transport Chain", "type": "detail", "explanation": "Series of protein complexes that transfer electrons and pump protons to create energy gradient", "parent": "c2"}},
  {{"id": "c4", "label": "Photosystem II", "type": "detail", "explanation": "Protein complex that absorbs light and splits water molecules", "parent": "c2"}},
  {{"id": "c5", "label": "Light-Independent Reactions", "type": "concept", "explanation": "Calvin Cycle reactions in stroma that use ATP and NADPH to fix CO2 into glucose", "parent": "c1"}},
  {{"id": "c6", "label": "Carbon Fixation", "type": "detail", "explanation": "First phase of Calvin Cycle where CO2 is attached to RuBP", "parent": "c5"}}
]

Transcript to analyze:
{transcript}"""

        api_key = os.getenv("GEMINI_API_KEY", "").strip()
        if not api_key:
            print("[ERROR] GEMINI_API_KEY not set; skipping concept extraction")
            return []

        genai.configure(api_key=api_key)

        system = (
            "You are an expert at creating hierarchical concept maps from educational content. "
            "Extract specific domain concepts and organize them into meaningful parent-child relationships. "
            "Return only a valid JSON array (no wrapper object, no markdown)."
        )
        full_input = f"{system}\n\n{prompt}"

        models_to_try = gemini_model_chain()
        last_error: Optional[Exception] = None

        for idx, model_name in enumerate(models_to_try):
            try:
                model = genai.GenerativeModel(
                    model_name,
                    generation_config=genai.GenerationConfig(
                        temperature=0.5,
                        max_output_tokens=800,
                        response_mime_type="application/json",
                    ),
                )

                def _generate():
                    return model.generate_content(full_input)

                response = await asyncio.to_thread(_generate)
                response_text = (response.text or "").strip()

                if response_text.startswith("```"):
                    response_text = response_text.split("```")[1]
                    if response_text.startswith("json"):
                        response_text = response_text[4:]
                    response_text = response_text.strip()

                concepts = json.loads(response_text)
                if not isinstance(concepts, list):
                    print("[WARNING] Gemini returned JSON that is not an array")
                    return []
                print(f"[CONCEPTS] Extracted {len(concepts)} concepts (model={model_name})")
                return concepts

            except json.JSONDecodeError as e:
                print(f"[WARNING] Could not parse Gemini response as JSON: {e}")
                return []
            except Exception as e:
                last_error = e
                can_try_next = idx < len(models_to_try) - 1 and _is_gemini_quota_or_rate_limit(e)
                if can_try_next:
                    nxt = models_to_try[idx + 1]
                    print(f"[Gemini] Model {model_name!r} quota/rate limit; trying {nxt!r}… ({e})")
                    continue
                print(f"[ERROR] Gemini API error: {e}")
                return []

        if last_error:
            print(f"[ERROR] Gemini API error (exhausted model chain): {last_error}")
        return []

    async def send_to_frontend(self, concepts: List[dict]):
        """
        Sends the extracted concepts back to the React app.

        We use LiveKit's "Data Channel" which is like a text messaging pipe
        between participants in the room. The React app listens for these messages.

        The message format:
        {
            "type": "concepts",
            "data": {
                "concepts": [...],
                "transcript": "...",
                "timestamp": "..."
            }
        }
        """
        message = {
            "type": "concepts",
            "data": {
                "concepts": concepts,
                "timestamp": datetime.now().isoformat()
            }
        }

        # Convert to JSON string, then to bytes (Data Channel requires bytes)
        message_bytes = json.dumps(message).encode("utf-8")

        # Publish to the room with topic "smartsketch"
        # Your React app will listen for messages with this topic
        await self.room.local_participant.publish_data(
            message_bytes,
            reliable=True,  # Make sure the message arrives
            topic="smartsketch"
        )

        print(f"[SENT] Concepts sent to frontend")


async def entrypoint(ctx: JobContext):
    """
    This is the main function that runs when the agent joins a room.

    JobContext contains:
    - ctx.room: The LiveKit room we're joining
    - ctx.proc: Information about this worker process

    This function:
    1. Connects to the room
    2. Sets up Deepgram for speech-to-text
    3. Listens for audio tracks and transcribes them
    """

    print(f"[AGENT] ✅ ENTRYPOINT CALLED FOR ROOM: {ctx.room.name}")
    print(f"[AGENT] Starting SmartSketch agent...")

    # Connect to the room
    # AutoSubscribe.AUDIO_ONLY means we only care about audio, not video
    # (We could add video later for OCR on slides)
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    print(f"[AGENT] Connected to room: {ctx.room.name}")
    print(f"[AGENT] Remote participants: {len(ctx.room.remote_participants)}")
    for participant in ctx.room.remote_participants.values():
        print(f"[AGENT]   - {participant.identity}: {len(participant.track_publications)} tracks")

    # Create our transcript processor
    processor = TranscriptProcessor(ctx.room)

    # Set up Deepgram for speech-to-text
    # Deepgram is a service that converts audio → text in real-time
    stt = deepgram.STT(
        model="nova-2",  # Their best model for accuracy
        language="en",   # English - change if needed
    )

    async def transcribe_track(track: rtc.Track):
        """
        Takes an audio track and continuously transcribes it.

        An "audio track" is like a stream of audio data from someone's microphone.
        We send this stream to Deepgram, and it sends back text as people speak.
        """
        print(f"[AUDIO] Starting transcription for track: {track.sid}")

        # Create an audio stream from the track
        audio_stream = rtc.AudioStream(track)

        # Create a speech-to-text stream
        # This is like opening a phone line to Deepgram
        stt_stream = stt.stream()

        async def process_audio():
            """Send audio frames to Deepgram"""
            try:
                async for event in audio_stream:
                    # event is AudioFrameEvent, we need the .frame property
                    stt_stream.push_frame(event.frame)
                    
                # When audio stream ends, let Deepgram know we're done sending audio
                # This allows it to finalize any pending transcriptions gracefully
                print(f"[AUDIO] Audio stream ended for track {track.sid}")
            except Exception as e:
                print(f"[AUDIO] Error in process_audio: {e}")

        async def process_transcription():
            """Receive transcription results from Deepgram"""
            try:
                print(f"[AUDIO] Starting to listen for transcription from stt_stream")
                async for event in stt_stream:
                    print(f"[AUDIO] Received event type: {event.type}")
                    # SpeechEventType.FINAL_TRANSCRIPT means the sentence is complete
                    # (as opposed to INTERIM which is still being processed)
                    if event.type == SpeechEventType.FINAL_TRANSCRIPT:
                        text = event.alternatives[0].text
                        if text.strip():
                            print(f"[TRANSCRIPT] {text}")
                            processor.add_transcript(text)
                    else:
                        print(f"[AUDIO] Ignoring event type {event.type}, waiting for FINAL_TRANSCRIPT")
                print(f"[AUDIO] stt_stream ended for track {track.sid}")
            except Exception as e:
                print(f"[AUDIO] Error in process_transcription: {e}")
                import traceback
                traceback.print_exc()

        # Run both tasks concurrently
        # - One sends audio to Deepgram
        # - One receives text from Deepgram
        # Use asyncio.gather with return_exceptions to handle both completing
        try:
            await asyncio.gather(
                process_audio(),
                process_transcription(),
                return_exceptions=True
            )
        except Exception as e:
            print(f"[AUDIO] Error in transcribe_track: {e}")
        finally:
            print(f"[AUDIO] Transcription task ended for track {track.sid}")

    # Listen for participant events
    @ctx.room.on("participant_joined")
    def on_participant_joined(participant: rtc.RemoteParticipant):
        """Called when a participant joins the room"""
        print(f"[ROOM] Participant joined: {participant.identity}")
    
    @ctx.room.on("participant_left")
    def on_participant_left(participant: rtc.RemoteParticipant):
        """Called when a participant leaves the room"""
        print(f"[ROOM] Participant left: {participant.identity}")

    # Listen for when participants publish audio tracks
    # This fires when someone (the student) starts their microphone
    @ctx.room.on("track_subscribed")
    def on_track_subscribed(
        track: rtc.Track,
        publication: rtc.TrackPublication,
        participant: rtc.RemoteParticipant
    ):
        """Called when we receive a new audio track from a participant"""
        print(f"[AUDIO] Track subscribed: kind={track.kind}, sid={track.sid}, participant={participant.identity}")
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            print(f"[AUDIO] New audio track from: {participant.identity}")
            # Start transcribing this audio track
            asyncio.create_task(transcribe_track(track))
        else:
            print(f"[AUDIO] Ignoring non-audio track: {track.kind}")

    # Also handle tracks that are already published when we join
    print(f"[AUDIO] Checking for existing audio tracks...")
    for participant in ctx.room.remote_participants.values():
        print(f"[AUDIO]   Participant {participant.identity} has {len(participant.track_publications)} publications")
        for publication in participant.track_publications.values():
            print(f"[AUDIO]     Publication: {publication.track_sid if publication.track else 'no-track'}, kind={publication.kind}")
            if publication.track and publication.track.kind == rtc.TrackKind.KIND_AUDIO:
                print(f"[AUDIO]     Found existing audio track, starting transcription")
                asyncio.create_task(transcribe_track(publication.track))
            else:
                print(f"[AUDIO]     Skipping non-audio or unpublished track")

    # Send a message to let the frontend know the agent is ready
    ready_message = json.dumps({
        "type": "agent_ready",
        "data": {"message": "SmartSketch agent is listening"}
    }).encode("utf-8")

    await ctx.room.local_participant.publish_data(
        ready_message,
        reliable=True,
        topic="smartsketch"
    )

    print("[AGENT] Ready and listening for audio...")

    # Keep the agent running indefinitely
    # It will continue processing audio until the room closes
    while ctx.room.connection_state == rtc.ConnectionState.CONN_CONNECTED:
        await asyncio.sleep(1)

    print("[AGENT] Room closed, shutting down")


def prewarm(proc: JobProcess):
    """
    This runs once when the agent worker starts up.
    Use it to load models or do other one-time setup.
    """
    print("[PREWARM] Agent worker starting...")
    # We could preload AI models here if needed
    pass


if __name__ == "__main__":
    """
    Entry point when you run: python main.py dev

    The 'cli.run_app' function registers this worker with LiveKit (see agent_name).
    The Next.js app embeds the same name in each participant JWT's roomConfig so
    LiveKit dispatches this worker when a new room is created (first join).
    """
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            prewarm_fnc=prewarm,
            # Must match SMARTSKETCH_AGENT_NAME in Next.js `src/app/api/livekit/token/route.ts`
            # so the access token's roomConfig dispatches this worker to new rooms.
            agent_name="smartsketch-worker",
        )
    )
