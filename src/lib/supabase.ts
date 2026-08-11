import { createClient } from "@supabase/supabase-js";

// Preenchidos quando o projeto Supabase novo existir de verdade
// (ver supabase/migrations/0001_schema.sql). Até lá, as telas usam os
// dados mockados em src/data/mockData.ts.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;
