# qbg-view

A Next.js 16 application for JEE/NEET question bank management with AI test generation.

## Stack
- **Framework**: Next.js 16 (App Router, Turbopack)
- **Styling**: Tailwind CSS + CSS custom properties for theming
- **Backend/DB**: Supabase (auth + database via `@supabase/ssr`)
- **Package manager**: npm
- **Math rendering**: KaTeX
- **PDF export**: Browser print window (handles KaTeX + images)
- **Word export**: docx library + file-saver

## Running the App
The app runs via the "Start application" workflow:
- Command: `npm run dev`
- Port: 5000 (bound to 0.0.0.0 for Replit compatibility)

## Required Environment Variables
- `NEXT_PUBLIC_SUPABASE_URL` — Supabase project URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Supabase anon/public key

## Features
- **Question Bank Browser**: Browse 14,944+ questions with filters by subject, chapter, topic, difficulty, source, etc.
- **Test Builder**: Create JEE Mains, JEE Advance, NEET, or Customised tests with question distribution control
- **Dark/Light mode toggle**: Sun/Moon button in the sidebar bottom section. Preference persisted to localStorage
- **PDF Download**: Opens browser print dialog with clean white-background, black-text layout including KaTeX math and images
- **Word Download**: Downloads a properly formatted .docx file with questions, answers, and solutions

## Project Structure
- `src/app/` — Next.js App Router pages and API routes
- `src/app/tests/page.tsx` — Test Builder (3700+ lines, includes PDF/Word download)
- `src/components/layout/Sidebar.tsx` — App sidebar with nav + theme toggle
- `src/components/questions/` — Question card + filter panel components
- `src/components/ui/MathContent.tsx` — KaTeX math renderer
- `src/lib/theme.tsx` — ThemeContext/ThemeProvider for dark/light mode
- `src/lib/downloadTest.ts` — PDF (print window) and Word (docx) export utilities
- `src/lib/supabase/` — Supabase client + server helpers
- `src/types/index.ts` — Full TypeScript type definitions
- `scripts/` — Utility scripts

## Product Updates (March 17, 2026)
- **Batch is optional in Test Builder**: Batch selection is no longer mandatory.
- **Default batch fallback**: If no batch is selected, generation/finalization now uses `NA`.
- **Batch UI simplification**: Removed `Other` batch sentinel flow; added compact inline single-line input to add new batch names.
- **Option label alignment**: Option number labels are centered with their option text container for consistent formatting in preview UI.
