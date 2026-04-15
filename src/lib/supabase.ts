import { createClient } from '@supabase/supabase-js';

const defaultUrl = 'https://gewngtjeujvieqtylxui.supabase.co';
const defaultAnonKey =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdld25ndGpldWp2aWVxdHlseHVpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg2OTQwNDksImV4cCI6MjA4NDI3MDA0OX0.vdmOwiDg0F8Svai3u7bGyipM2wMmimyjT8-lM1Go2AI';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || defaultUrl;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || defaultAnonKey;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
