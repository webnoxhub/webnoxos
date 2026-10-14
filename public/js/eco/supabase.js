// The workspace app shares the one Supabase client the rest of Webnox uses.
import { getClient } from '/js/supabase.js';

export const supabase = await getClient();
