# Smart Sketch - Where to Begin

This document guides you through understanding the Smart Sketch architecture and where to start customizing the application.

## 🎯 Quick Start Development Guide

### 1. **Setting Up Your Development Environment**

First, ensure you have the necessary accounts and credentials:

1. **LiveKit Account**: Sign up at [livekit.io](https://livekit.io)
   - Create a new project
   - Note your API key, secret, and WebSocket URL
   
2. **Google Gemini**: Create an API key at [Google AI Studio](https://aistudio.google.com/apikey)
   - Set `GEMINI_API_KEY` in `.env.local` (and `agent/.env` if you run the Python worker)

3. **Configure `.env.local`**:
   ```bash
   cp .env.example .env.local
   # Edit .env.local with your credentials
   ```

### 2. **Understanding the Application Flow**

There are **two** capture paths:

**A. `/record` (primary)** — LiveKit + optional Python agent  
```
User signs in → /home → /record
         ↓
Browser: camera/mic (getUserMedia), optional LiveKit publish
         ↓
If Python agent is running: remote audio → Deepgram STT → Gemini concepts → LiveKit data channel (topic smartsketch)
         ↓
If LiveKit URL missing OR agent never joins (grace period): Web Speech in browser → /api/process-transcript → same mind map
         ↓
React Flow mind map (addConceptsToMap) + optional Gemini chat + save to Supabase
```

**B. `/lecture`** — Browser-first  
```
User opens /lecture → LiveKitRoom for preview + Web Speech final transcripts
         ↓
Buffered text → /api/process-transcript (Gemini, hierarchical JSON with id/parent)
         ↓
MindMapVisualization (React Flow) with a session root node and edges
```

Shared types for AI output: `src/lib/concept-types.ts` (`ConceptPayload`).

## 📁 Key Files and Their Purpose

### **Core Application Files**

#### `src/app/page.tsx` - Marketing / auth landing
- Landing hero and embedded `AuthForm` (sign in / sign up)
- **After login**, users go to `/home` (not lecture from this page alone)

#### `src/app/home/page.tsx` - Signed-in hub
- Links to `/record`, `/library`, and `/lecture`

#### `src/app/record/page.tsx` - Primary recording session
- LiveKit connect + publish tracks; `DataReceived` → concepts
- Browser STT fallback when LiveKit is off or `allowStartWithoutAgent` is true
- **Customize**: layout, batching interval (local STT uses 10s), mind map styling

#### `src/app/lecture/page.tsx` - Lecture / browser STT UI
- Split-screen: `LiveKitCapture` + `MindMapVisualization`
- Session start/stop controls
- **Customize**: Layout, additional controls, recording features

#### `src/app/demo/page.tsx` - Interactive Demo
- Step-by-step demonstration of concept building
- No LiveKit/Gemini required
- **Customize**: Demo data, visualization examples

### **Component Files**

#### `src/components/LiveKitCapture.tsx` - Video/Audio Capture (lecture page)
**Purpose**: LiveKit token + room, **Web Speech API** for finals-only captions, periodic `/api/process-transcript`

**Key Functions**:
- `fetchToken()` — LiveKit access token (`authFetch`)
- `handleTranscript()` — buffers text, starts 10s interval to call the API
- `simulateTranscript()` — demo lines for testing (interval cleared on unmount)

#### `src/components/MindMapVisualization.tsx` - Mind Map Rendering (lecture page)
**Purpose**: Builds React Flow nodes/edges from `ConceptPayload[]` (including `parent` links). Inserts a small **Session** root node and edges from it for top-level concepts.

#### `agent/main.py` - LiveKit worker
**Purpose**: Subscribes to published **audio**, streams frames to **Deepgram**, batches finals, calls **Gemini**, `publish_data` topic `smartsketch`. Env: `agent/.env` (`DEEPGRAM_API_KEY`, `GEMINI_API_KEY`, LiveKit).

### **API Routes**

#### `src/app/api/livekit/token/route.ts`
**Purpose**: Authenticated LiveKit access tokens (`getAuthenticatedUser`).

#### `src/app/api/process-transcript/route.ts`
**Purpose**: Authenticated transcript → **Gemini** (default `gemini-2.0-flash`, override with `GEMINI_MODEL`) JSON with **hierarchical** `concepts` (`id`, `label`, `type`, `explanation`, `parent`). Normalizes missing ids/parents server-side.

### **Utility Files**

#### `src/lib/utils.ts`
Helper functions for:
- Node positioning calculation
- Keyword extraction
- Concept merging and deduplication

**Where to Start**:
- `calculateNodePosition()` - Customize layout algorithms
- `extractKeywords()` - Improve NLP processing
- `mergeConcepts()` - Add concept relationship detection

#### `src/types/index.ts`
TypeScript definitions for:
- Concepts
- Lecture sessions
- Configuration interfaces

## 🔧 Common Customization Tasks

### **1. Change Mind Map Layout**

Edit `src/components/MindMapVisualization.tsx`:

```typescript
// Current: Radial layout
const angle = (conceptCount * Math.PI * 2) / ...

// Change to: Hierarchical tree layout
position = {
  x: level * 200,
  y: index * 100
}
```

### **2. Add Real Speech-to-Text**

Replace simulation in `src/components/LiveKitCapture.tsx`:

```typescript
// Add Web Speech API or third-party service
const recognition = new webkitSpeechRecognition();
recognition.onresult = (event) => {
  const transcript = event.results[0][0].transcript;
  handleTranscript(transcript);
};
```

### **3. Customize AI Concept Extraction**

Edit `src/app/api/process-transcript/route.ts`:

```typescript
// Current prompt focuses on educational concepts
// Modify the system message for different use cases:
content: `Extract technical terms and their relationships...`
content: `Identify main arguments and supporting evidence...`
content: `Find key takeaways and action items...`
```

### **4. Add Session Recording**

In `src/app/lecture/page.tsx`:

```typescript
const [recording, setRecording] = useState([]);

const handleConceptExtracted = (concept) => {
  setConceptData(prev => [...prev, concept]);
  setRecording(prev => [...prev, {
    concept,
    timestamp: Date.now()
  }]);
};

// Add export button
const exportSession = () => {
  const data = JSON.stringify(recording);
  // Download or save to backend
};
```

### **5. Improve Node Styling**

Edit `src/components/MindMapVisualization.tsx`:

```typescript
// Add custom node types
const nodeTypes = {
  main: MainNode,
  concept: ConceptNode,
  detail: DetailNode,
};

// Create custom components
const MainNode = ({ data }) => (
  <div className="custom-main-node">
    <h3>{data.label}</h3>
    <p>{data.explanation}</p>
  </div>
);
```

## 🚀 Next Steps for Development

### **Immediate Priorities**

1. **Add Real Transcription**
   - Integrate Web Speech API or Deepgram
   - File: `src/components/LiveKitCapture.tsx`

2. **Enhance AI Prompts**
   - Test different prompts for better concept extraction
   - File: `src/app/api/process-transcript/route.ts`

3. **Improve Layout Algorithm**
   - Implement force-directed layout or dagre
   - File: `src/components/MindMapVisualization.tsx`

### **Feature Enhancements**

1. **User Authentication**
   - Add NextAuth.js
   - Protect lecture sessions
   - Save user preferences

2. **Session Management**
   - Store sessions in database
   - Allow replay of past lectures
   - Export as PDF/Image

3. **Collaborative Features**
   - Multiple viewers per session
   - Shared annotations
   - Real-time sync

4. **Advanced Visualizations**
   - Timeline view
   - 3D mind maps
   - Custom themes

5. **Mobile Support**
   - Responsive design improvements
   - Touch gestures for mind map
   - Native mobile app

## 📚 Helpful Resources

- **LiveKit Docs**: https://docs.livekit.io
- **ReactFlow Docs**: https://reactflow.dev/learn
- **Gemini API**: https://ai.google.dev/docs
- **Next.js Docs**: https://nextjs.org/docs

## 🐛 Troubleshooting

### "LiveKit credentials not configured"
- Ensure `.env.local` exists with correct values
- Restart dev server after changing env files

### "Failed to connect to LiveKit"
- Check LiveKit URL format (must start with wss://)
- Verify API key and secret are correct
- Test connection at livekit.io console

### "Gemini API key not configured" / model errors
- Use the exact name **`GEMINI_API_KEY`** in `.env.local` (and `agent/.env` for the worker); restart Next.js after edits
- **`GEMINI_MODEL`**: preferred first model; on **quota / rate limit** the app tries additional models automatically (same defaults in Next.js and `agent/main.py`).
- **`GEMINI_MODEL_FALLBACKS`**: comma-separated models after the primary; **`GEMINI_MODEL_CHAIN`**: optional full ordered list (overrides primary + fallbacks).

### Mind map nodes overlap
- Adjust position calculations in `MindMapVisualization.tsx`
- Increase spacing multipliers
- Consider using auto-layout libraries

## 💡 Tips

- Use the **demo mode** (`/demo`) to test visualization changes without LiveKit
- The **simulate transcript** button lets you test AI processing locally
- Check browser console for detailed error messages
- Use React DevTools to inspect component state

---

**Ready to build?** Start with the demo, customize the AI prompts, then integrate real transcription. Good luck! 🚀
