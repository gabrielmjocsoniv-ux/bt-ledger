# Bryle & Tintin Ledger

Private household ledger. The page is static; all data lives in a Supabase database behind login and row-level security, so only the two member emails can read or write anything.

- `index.html` – the app
- `connect.js` – login, live sync and backups (Supabase)
- `config.js` – Supabase project URL and anon key (public by design)
- `supabase.js` – vendored @supabase/supabase-js 2.116.0
