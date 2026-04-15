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
        mind_map_nodes: nodes,
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

    return data || [];
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

    return data;
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
