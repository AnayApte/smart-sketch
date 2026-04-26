import { Node, Edge } from 'reactflow';
import { supabase } from '@/lib/supabase';

export interface SavedSession {
  id: string;
  user_id: string;
  title: string;
  transcript: string;
  mind_map_nodes: Node[];
  mind_map_edges: Edge[];
  audio_file_url?: string;
  created_at: string;
  updated_at: string;
}

function isRenderableReactNode(label: unknown): boolean {
  if (label == null || typeof label !== 'object') return false;
  return (
    typeof (label as { $$typeof?: symbol }).$$typeof === 'symbol' &&
    typeof (label as { type?: unknown }).type !== 'undefined'
  );
}

/** Serialized React elements become plain `{ type, props, key, ... }` — not valid as React children. */
function isSerializedReactElementLike(label: unknown): boolean {
  if (label == null || typeof label !== 'object' || Array.isArray(label)) return false;
  const o = label as Record<string, unknown>;
  return 'type' in o && 'props' in o && !isRenderableReactNode(label);
}

function plainTextFromNodeData(data: Record<string, unknown> | undefined): string {
  if (!data) return 'Node';
  const pl = data.plainLabel;
  if (typeof pl === 'string' && pl.trim()) return pl.trim();
  const lb = data.label;
  if (typeof lb === 'string' && lb.trim()) return lb.trim();
  if (isSerializedReactElementLike(lb)) {
    const props = (lb as { props?: { children?: unknown } }).props;
    const ch = props?.children;
    const first = Array.isArray(ch) ? ch[0] : ch;
    if (first && typeof first === 'object' && first !== null && 'props' in (first as object)) {
      const inner = (first as { props?: { children?: unknown } }).props?.children;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    }
  }
  return 'Node';
}

/** Second child of mind-map label JSX is the description line (serialized DB shape). */
function extractDescriptionFromSerializedLabel(label: unknown): string {
  if (!isSerializedReactElementLike(label)) return '';
  const kids = (label as { props?: { children?: unknown } }).props?.children;
  if (!Array.isArray(kids) || kids.length < 2) return '';
  const second = kids[1] as { props?: { children?: unknown } } | undefined;
  if (!second || typeof second !== 'object' || !('props' in second)) return '';
  const inner = second.props?.children;
  return typeof inner === 'string' ? inner.trim() : '';
}

function extractDescriptionFromLiveReactLabel(label: unknown): string {
  if (!isRenderableReactNode(label)) return '';
  const props = (label as { props?: { children?: unknown } }).props;
  const ch = props?.children;
  if (!Array.isArray(ch) || ch.length < 2) return '';
  const second = ch[1] as { props?: { children?: unknown } } | undefined;
  if (!second || typeof second !== 'object' || !('props' in second)) return '';
  const inner = second.props?.children;
  return typeof inner === 'string' ? inner.trim() : '';
}

function resolvePlainDescription(data: Record<string, unknown>, label: unknown): string {
  const pd = data.plainDescription;
  if (typeof pd === 'string' && pd.trim()) return pd.trim();
  return extractDescriptionFromSerializedLabel(label) || extractDescriptionFromLiveReactLabel(label);
}

/** Strip JSX from `data.label` so JSON/Supabase round-trips safely; React Flow accepts string labels. */
export function sanitizeMindMapNodesForStorage(nodes: Node[]): Node[] {
  return nodes.map((node) => {
    const data = (node.data || {}) as Record<string, unknown>;
    const plain = plainTextFromNodeData(data);
    const label = data.label;
    const plainDesc = resolvePlainDescription(data, label);
    return {
      ...node,
      data: {
        ...data,
        plainLabel: plain,
        plainDescription: plainDesc,
        label: plain,
      },
    };
  });
}

/** Fix nodes loaded from DB where `label` was JSX and became a plain object after JSON.parse. */
export function normalizeMindMapNodesFromDb(nodes: unknown): Node[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((raw) => {
    const node = raw as Node;
    const data = (node.data || {}) as Record<string, unknown>;
    const plain = plainTextFromNodeData(data);
    const label = data.label;
    const plainDesc = resolvePlainDescription(data, label);
    if (typeof label === 'string' && !isSerializedReactElementLike(label) && !isRenderableReactNode(label)) {
      return {
        ...node,
        data: {
          ...data,
          plainLabel:
            typeof data.plainLabel === 'string' && data.plainLabel.trim() ? data.plainLabel : label.trim(),
          plainDescription: plainDesc,
          label: plain,
        },
      };
    }
    if (isRenderableReactNode(label)) {
      return {
        ...node,
        data: {
          ...data,
          plainLabel: plain,
          plainDescription: plainDesc,
          label: plain,
        },
      };
    }
    return {
      ...node,
      data: {
        ...data,
        plainLabel: plain,
        plainDescription: plainDesc,
        label: plain,
      },
    };
  });
}

function normalizeSessionRow(row: SavedSession): SavedSession {
  return {
    ...row,
    mind_map_nodes: normalizeMindMapNodesFromDb(row.mind_map_nodes),
  };
}

/**
 * Upload audio file to Supabase Storage
 * Returns the public URL of the uploaded file
 */
async function uploadAudioFile(
  userId: string,
  audioBlob: Blob,
  fileName: string
): Promise<{ success: boolean; url?: string; error?: string }> {
  try {
    const filePath = `${userId}/${Date.now()}-${fileName}`;
    
    const { data, error } = await supabase.storage
      .from('session-audio')
      .upload(filePath, audioBlob, {
        contentType: 'audio/webm',
        upsert: false,
      });

    if (error) {
      console.error('Error uploading audio:', error);
      return { success: false, error: error.message };
    }

    // Get public URL
    const { data: publicData } = supabase.storage
      .from('session-audio')
      .getPublicUrl(filePath);

    return { success: true, url: publicData.publicUrl };
  } catch (error) {
    console.error('Unexpected error uploading audio:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Save a completed recording session to Supabase
 * Stores the recording title, full transcript, React Flow mind map, and audio file
 */
export async function saveSession(
  userId: string,
  title: string,
  transcript: string,
  nodes: Node[],
  edges: Edge[],
  audioBlob?: Blob
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  try {
    let audioFileUrl: string | undefined;

    // Upload audio file if provided
    if (audioBlob) {
      console.log('[saveSession] Audio blob received, size:', audioBlob.size, 'bytes');
      const audioResult = await uploadAudioFile(userId, audioBlob, `${title}.webm`);
      console.log('[saveSession] Audio upload result:', audioResult);
      if (audioResult.success) {
        audioFileUrl = audioResult.url;
        console.log('[saveSession] Audio file URL set to:', audioFileUrl);
      } else {
        console.warn('Failed to upload audio:', audioResult.error);
        // Continue without audio - don't fail the entire save
      }
    } else {
      console.log('[saveSession] No audio blob provided');
    }

    const { data, error } = await supabase
      .from('sessions')
      .insert({
        user_id: userId,
        title,
        transcript,
        mind_map_nodes: sanitizeMindMapNodesForStorage(nodes),
        mind_map_edges: edges,
        audio_file_url: audioFileUrl,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.error('Error saving session:', error);
      return { success: false, error: error.message };
    }

    return { success: true, sessionId: data?.id };
  } catch (error) {
    console.error('Unexpected error saving session:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Get all sessions for the current user
 */
export async function getUserSessions(userId: string): Promise<SavedSession[]> {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching sessions:', error);
      return [];
    }

    return (data || []).map((row) => normalizeSessionRow(row as SavedSession));
  } catch (error) {
    console.error('Unexpected error fetching sessions:', error);
    return [];
  }
}

/**
 * Get a single session by ID
 */
export async function getSession(sessionId: string): Promise<SavedSession | null> {
  try {
    const { data, error } = await supabase
      .from('sessions')
      .select('*')
      .eq('id', sessionId)
      .single();

    if (error) {
      console.error('Error fetching session:', error);
      return null;
    }

    return normalizeSessionRow(data as SavedSession);
  } catch (error) {
    console.error('Unexpected error fetching session:', error);
    return null;
  }
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('sessions')
      .delete()
      .eq('id', sessionId);

    if (error) {
      console.error('Error deleting session:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Unexpected error deleting session:', error);
    return false;
  }
}

/**
 * Update a session
 */
export async function updateSession(
  sessionId: string,
  updates: Partial<Omit<SavedSession, 'id' | 'user_id' | 'created_at'>>
): Promise<boolean> {
  try {
    const { error } = await supabase
      .from('sessions')
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sessionId);

    if (error) {
      console.error('Error updating session:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Unexpected error updating session:', error);
    return false;
  }
}
