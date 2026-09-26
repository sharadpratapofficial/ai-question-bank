# QBG View — Implementation Plan

> **Version**: 2.1  
> **Last Updated**: 2026-02-15  
> **Tech Stack**: Next.js 15 · TypeScript · Tailwind CSS · Supabase (DB + Auth + Storage) · AI (Gemini API)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Actual Data Shape & Access Strategy](#2-actual-data-shape--access-strategy)
3. [Architecture](#3-architecture)
4. [Database Schema](#4-database-schema)
5. [Phase 1 — Foundation & Core Infrastructure](#phase-1--foundation--core-infrastructure)
6. [Phase 2 — Question Browsing & Filtering](#phase-2--question-browsing--filtering)
7. [Phase 3 — Question CRUD & Rich Editor](#phase-3--question-crud--rich-editor)
8. [Phase 4 — Authentication & Role-Based Access](#phase-4--authentication--role-based-access)
9. [Phase 5 — Test Generation & PDF Export](#phase-5--test-generation--pdf-export)
10. [Phase 6 — AI-Powered Features](#phase-6--ai-powered-features)
11. [Phase 7 — Analytics, Duplicates & Advanced Tools](#phase-7--analytics-duplicates--advanced-tools)
12. [Phase 8 — Student Test Mode](#phase-8--student-test-mode)
13. [Non-Functional Requirements](#non-functional-requirements)
14. [Deployment Strategy](#deployment-strategy)
15. [Verification Strategy](#verification-strategy)

---

## 2. Actual Data Shape & Access Strategy

> **CRITICAL**: This section documents the real data format in the existing Supabase `questions` table, analyzed from live samples. All code must respect this shape.

### 2.1 Current `questions` Table Schema (Flat, Denormalized)

The existing Supabase table stores metadata as **plain text strings**, NOT foreign keys:

| Column | Type | Example Values | Notes |
|--------|------|----------------|-------|
| `question_id` | UUID | `192743d3-8d03-4b31-bf5b-...` | Primary key |
| `qbg_id` | TEXT | `mhbjrkua47bbo70t7ekp9ecse` | Legacy QBG system ID |
| `question_text` | TEXT (HTML) | `<p>...<sub>...</sub>...<math>...</math></p>` | Contains MathML, `<img>`, `<sub>`, `<sup>` |
| `options` | JSONB | `[{text: "<p>...</p>", isCorrect: true}, ...]` | **Can be null** for Integer-type Qs |
| `answer_key` | JSONB | `[1]`, `[1,3]`, `243` | ⚠️ **Mixed types**: array OR number |
| `solution_text` | TEXT (HTML) | `<p>...<math>...</math></p>` | Contains MathML |
| `question_type` | TEXT | `Single_Choice(SCQ)`, `Multi_Choice(MCQ)`, `Integer`, `Assertion_Reason(AR)`, `Matching_List(ML)` | |
| `subject` | TEXT | `Physics`, `Chemistry`, `Maths` | |
| `chapter` | TEXT | `Chemical Bonding and Molecular Structure`, `Electric Charges and Fields` | |
| `topic` | TEXT | `Hybridisation`, `Electric Field`, `Modulus` | |
| `source` | TEXT | `AIR` | |
| `difficutly_level` | TEXT | `Easy`, `Medium`, `Hard` | ⚠️ **Typo**: missing 'i' in "difficulty" |
| `parent_question_id` | UUID / NULL | | For linked/paragraph questions |
| `raw_data` | JSONB | `[{conceptTags: [...], examDetails: [...], ...}]` | Full QBG system data, goldmine for hierarchy |

### 2.2 Hidden Data in `raw_data` (Extractable)

The `raw_data[0]` object contains rich hierarchical information:

```
raw_data[0].conceptTags[0].subject   → { subject_id, english_name }
raw_data[0].conceptTags[0].chapter   → { chapter_id, english_name }
raw_data[0].conceptTags[0].topic     → { topic_id, english_name }
raw_data[0].conceptTags[0].subtopic  → { subtopic_id, english_name }
raw_data[0].conceptTags[0].class     → { class_id, english_name: "11"/"12" }
raw_data[0].examDetails[0]           → { english_name: "JEE Mains"/"JEE Advanced" }
raw_data[0].solutions[0].english.videoSolution.url → video URL
raw_data[0].difficulty               → 1 (Easy), 2 (Medium), 3 (Hard)
raw_data[0].verification_status      → 0 or 1
raw_data[0].type                     → 1=SCQ, 2=MCQ, 3=Integer, 7=AR, 9=ML
```

### 2.3 Known Data Values

| Filter | Known Values |
|--------|--------------|
| Subjects | Physics, Chemistry, Maths |
| Question Types | Single_Choice(SCQ), Multi_Choice(MCQ), Integer, Assertion_Reason(AR), Matching_List(ML) |
| Difficulty | Easy, Medium, Hard |
| Sources | AIR (possibly more) |
| Exams | JEE Mains, JEE Advanced (possibly NEET) |
| Class Levels | 11, 12 |
| Chapters | ~50+ (Chemical Bonding, Electric Charges, Rotational Motion, Binomial Theorem, etc.) |

### 2.4 ⚠️ Data Quirks to Handle

1. **`difficutly_level`** — Typo in column name. App must use this exact spelling when querying.
2. **`answer_key` mixed types** — Sometimes `[1]` (array), sometimes `243` (bare number). Normalize in app:
   ```typescript
   const normalizeAnswerKey = (ak: number | number[]): number[] => 
     Array.isArray(ak) ? ak : [ak];
   ```
3. **Null options** — Integer-type questions have `[{text: null, isCorrect: null}, ...]`.
4. **Video URLs** — Two domains: `d1d34p8vz63oiq.cloudfront.net` (DASH/MPD format) and `youtube.com`. Need different player strategies.
5. **No subtopic column at top level** — Subtopics are only in `raw_data`. Must extract if needed.
6. **No class_level column at top level** — Must extract from `raw_data[0].conceptTags[0].class.english_name`.
7. **No exam column at top level** — Must extract from `raw_data[0].examDetails[0].english_name`.

### 2.5 Filter Population Strategy

**No MCP needed.** Filters populated via Supabase JS client in Next.js API routes / Server Components.

#### Strategy A: Direct `SELECT DISTINCT` (Phase 1 — Quick Start)

```typescript
// lib/api/metadata.ts — Get filter values directly from questions table

export async function getFilterOptions(supabase: SupabaseClient) {
  // Run all in parallel
  const [subjects, chapters, topics, types, difficulties, sources] = await Promise.all([
    supabase.from('questions').select('subject').order('subject'),
    supabase.from('questions').select('subject, chapter').order('chapter'),
    supabase.from('questions').select('chapter, topic').order('topic'),
    supabase.from('questions').select('question_type').order('question_type'),
    supabase.from('questions').select('difficutly_level').order('difficutly_level'),  // typo preserved!
    supabase.from('questions').select('source').order('source'),
  ]);

  return {
    subjects: [...new Set(subjects.data?.map(q => q.subject))],
    // chapters grouped by subject for cascading:
    chaptersBySubject: groupBy(chapters.data, 'subject', 'chapter'),
    topicsByChapter: groupBy(topics.data, 'chapter', 'topic'),
    questionTypes: [...new Set(types.data?.map(q => q.question_type))],
    difficultyLevels: [...new Set(difficulties.data?.map(q => q.difficutly_level))],
    sources: [...new Set(sources.data?.map(q => q.source))],
  };
}

// Cascading filter: when user selects a subject, get its chapters
export async function getChaptersForSubject(supabase: SupabaseClient, subject: string) {
  const { data } = await supabase
    .from('questions')
    .select('chapter')
    .eq('subject', subject)
    .order('chapter');
  return [...new Set(data?.map(q => q.chapter))];
}
```

#### Strategy B: Metadata Hierarchy View (Phase 1.5 — Better Performance)

Create a PostgreSQL materialized view for fast filter loading:

```sql
-- Run once in Supabase SQL Editor
CREATE MATERIALIZED VIEW metadata_hierarchy AS
SELECT DISTINCT
  subject,
  chapter,
  topic,
  raw_data->0->'conceptTags'->0->'subtopic'->>'english_name' as subtopic,
  raw_data->0->'conceptTags'->0->'class'->>'english_name' as class_level,
  raw_data->0->'examDetails'->0->>'english_name' as exam
FROM questions
WHERE raw_data IS NOT NULL
ORDER BY subject, chapter, topic;

-- Refresh when data changes
CREATE OR REPLACE FUNCTION refresh_metadata_hierarchy()
RETURNS TRIGGER AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY metadata_hierarchy;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_refresh_metadata
AFTER INSERT OR UPDATE OR DELETE ON questions
FOR EACH STATEMENT EXECUTE FUNCTION refresh_metadata_hierarchy();
```

#### Strategy C: Dedicated Metadata Tables (Phase 3 — Full CRUD)

When Metadata Admin needs to create/edit/delete metadata entries, separate tables are created and populated from the materialized view. New questions will reference these tables as well as storing flat text for backward compatibility.

### 2.6 Supabase Connection (What You Need to Provide)

To proceed with implementation, I need:

1. **Supabase Project URL** — e.g., `https://xxxxx.supabase.co`
2. **Supabase Anon Key** — public key for client-side queries
3. **Supabase Service Role Key** (optional) — for server-side operations that bypass RLS
4. **Total question count** — approximate number of questions currently in the table
5. **Google OAuth Client ID** — for authentication (can be added later in Phase 4)
6. **Gemini API Key** — for AI features (can be added later in Phase 6)

---

## 1. Project Overview

**QBG View** is a comprehensive **Question Bank Management System** for educational teams (primarily JEE/NEET preparation). It provides:

- **Browse & Search**: Filter thousands of questions across subjects, chapters, topics, difficulty, and custom tags
- **CRUD Operations**: Create, edit, and delete questions with a rich-text editor supporting MathML/LaTeX and images
- **Bulk Import**: Import questions from Word/PDF files with AI-assisted metadata tagging
- **Test Generation**: Build tests from templates or custom criteria, export as formatted PDFs
- **Team Collaboration**: Role-based access (Viewer, Editor, Metadata Admin, Admin) with full edit history
- **AI Integration**: Auto-classify questions, verify answers, suggest improvements, detect duplicates
- **Student Test Mode**: Online test-taking with timer, auto-grading, and score reports
- **Analytics**: Question usage tracking, distribution dashboards, batch management

### Target Users

| Role              | Permissions                                                                 |
|-------------------|-----------------------------------------------------------------------------|
| **Viewer**        | Browse questions, view solutions, use filters, take student tests           |
| **Editor**        | All Viewer + Create/edit/delete questions, generate tests, bulk import      |
| **Metadata Admin**| All Editor + Create/edit/delete metadata (subjects, chapters, topics, etc.) |
| **Admin**         | Full access + Manage users & roles, system settings                        |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js 15)                │
│  ┌─────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐  │
│  │ Browse  │ │  Editor  │ │Test Builder│ │ Student Mode │  │
│  │  Page   │ │   Page   │ │    Page    │ │    Page      │  │
│  └────┬────┘ └────┬─────┘ └─────┬──────┘ └──────┬───────┘  │
│       │           │             │                │          │
│  ┌────▼───────────▼─────────────▼────────────────▼───────┐  │
│  │              Next.js API Routes (Route Handlers)      │  │
│  └────────────────────────┬──────────────────────────────┘  │
└───────────────────────────┼─────────────────────────────────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
    ┌──────▼──────┐  ┌──────▼──────┐  ┌──────▼──────┐
    │  Supabase   │  │  Supabase   │  │  Gemini AI  │
    │  Database   │  │  Storage    │  │    API      │
    │  (Postgres) │  │  (Images)   │  │             │
    └─────────────┘  └─────────────┘  └─────────────┘
```

### Key Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Next.js 15 (App Router) | SSR, API routes, React Server Components |
| Database | Supabase (PostgreSQL) | Real-time, RLS, auth, storage in one |
| Auth | Supabase Auth (Google OAuth) | No domain restriction, easy role management |
| Styling | Tailwind CSS 3 | Already set up, rapid UI development |
| Math Rendering | MathJax 3 | Best MathML + LaTeX support in browser |
| PDF Export | jsPDF + html2canvas | Client-side PDF generation |
| Rich Text Editor | TipTap | Extensible, supports custom nodes (math, images) |
| AI | Google Gemini API | Powerful, supports multimodal (text + image) |
| Image Storage | Supabase Storage (→ S3 later) | Start simple, migrate when needed |
| Icons | Lucide React | Already installed, tree-shakable |

---

## 3. Database Schema

### 3.1 Core Tables

```sql
-- ==================== METADATA TABLES ====================

CREATE TABLE subjects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE chapters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subject_id UUID NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(subject_id, name)
);

CREATE TABLE topics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chapter_id UUID NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(chapter_id, name)
);

CREATE TABLE subtopics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    topic_id UUID NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(topic_id, name)
);

CREATE TABLE sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE difficulty_levels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    display_order INT DEFAULT 0
);

CREATE TABLE question_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,  -- e.g., 'SCQ', 'MCQ', 'Integer', 'Matrix Match'
    description TEXT
);

CREATE TABLE exams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE   -- e.g., 'JEE Mains', 'JEE Advanced', 'NEET'
);

CREATE TABLE tags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,  -- e.g., 'PYQ 2024', 'frequently asked', 'tricky'
    color TEXT DEFAULT '#6366f1',
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== QUESTIONS ====================

CREATE TABLE questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    qbg_id TEXT UNIQUE,                           -- legacy ID from QBG system
    question_text TEXT NOT NULL,                    -- HTML with MathML
    solution_text TEXT DEFAULT '',                  -- HTML with MathML
    question_type_id UUID NOT NULL REFERENCES question_types(id),
    subject_id UUID NOT NULL REFERENCES subjects(id),
    chapter_id UUID NOT NULL REFERENCES chapters(id),
    topic_id UUID REFERENCES topics(id),
    subtopic_id UUID REFERENCES subtopics(id),
    source_id UUID REFERENCES sources(id),
    difficulty_level_id UUID REFERENCES difficulty_levels(id),
    exam_id UUID REFERENCES exams(id),
    class_level TEXT,                              -- e.g., '11', '12'
    parent_question_id UUID REFERENCES questions(id) ON DELETE SET NULL,
    video_solution_url TEXT,
    answer_key JSONB NOT NULL DEFAULT '[]',        -- [1] for SCQ, [1,3] for MCQ, [42] for integer
    options JSONB NOT NULL DEFAULT '[]',           -- [{text: "...", isCorrect: true/false}, ...]
    is_verified BOOLEAN DEFAULT false,             -- AI or human verified
    is_active BOOLEAN DEFAULT true,                -- soft delete
    created_by UUID REFERENCES auth.users(id),
    updated_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE question_tags (
    question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
    tag_id UUID REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (question_id, tag_id)
);

CREATE TABLE question_images (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    image_url TEXT NOT NULL,                        -- Supabase storage URL or external
    image_type TEXT DEFAULT 'question',             -- 'question' | 'solution' | 'option'
    display_order INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== EDIT HISTORY ====================

CREATE TABLE question_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    changed_by UUID NOT NULL REFERENCES auth.users(id),
    changed_at TIMESTAMPTZ DEFAULT now(),
    change_type TEXT NOT NULL,                     -- 'create' | 'update' | 'delete' | 'restore'
    changes JSONB NOT NULL,                        -- { field: { old: ..., new: ... } }
    snapshot JSONB NOT NULL                        -- full question state at that point
);

-- ==================== TESTS ====================

CREATE TABLE test_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,                            -- e.g., 'JEE Mains Full Test'
    description TEXT,
    config JSONB NOT NULL,                         -- { duration, positive_marks, negative_marks, sections: [...] }
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    subtitle TEXT,
    template_id UUID REFERENCES test_templates(id),
    batch_name TEXT,                               -- batch tracking for question reuse prevention
    config JSONB NOT NULL,                         -- full test configuration
    question_ids UUID[] NOT NULL,                  -- ordered list of question IDs
    sections JSONB NOT NULL,                       -- [ { name, subject, question_ids } ]
    status TEXT DEFAULT 'draft',                   -- 'draft' | 'finalized' | 'shared'
    share_token TEXT UNIQUE,                       -- for shareable links
    pdf_url TEXT,                                  -- stored PDF link
    is_student_accessible BOOLEAN DEFAULT false,   -- whether students can take this test
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE question_batch_usage (
    question_id UUID REFERENCES questions(id) ON DELETE CASCADE,
    test_id UUID REFERENCES tests(id) ON DELETE CASCADE,
    batch_name TEXT NOT NULL,
    used_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (question_id, test_id)
);

-- ==================== STUDENT TEST ATTEMPTS ====================

CREATE TABLE test_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id UUID NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES auth.users(id),
    started_at TIMESTAMPTZ DEFAULT now(),
    finished_at TIMESTAMPTZ,
    time_spent_seconds INT,
    status TEXT DEFAULT 'in_progress',             -- 'in_progress' | 'submitted' | 'timed_out'
    responses JSONB NOT NULL DEFAULT '{}',         -- { question_id: { selected: [1], time_spent: 45 } }
    score JSONB,                                   -- { total, correct, incorrect, unattempted, marks }
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== SAVED FILTERS ====================

CREATE TABLE saved_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    filters JSONB NOT NULL,                        -- FilterState object
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== USER PROFILES & ROLES ====================

CREATE TABLE user_profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    full_name TEXT,
    avatar_url TEXT,
    role TEXT NOT NULL DEFAULT 'viewer',            -- 'viewer' | 'editor' | 'metadata_admin' | 'admin'
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== DUPLICATE TRACKING ====================

CREATE TABLE duplicate_pairs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id_a UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    question_id_b UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    similarity_score FLOAT NOT NULL,               -- 0.0 to 1.0
    status TEXT DEFAULT 'pending',                 -- 'pending' | 'confirmed' | 'dismissed'
    reviewed_by UUID REFERENCES auth.users(id),
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(question_id_a, question_id_b)
);

-- ==================== AI SUGGESTIONS ====================

CREATE TABLE ai_suggestions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    suggestion_type TEXT NOT NULL,                  -- 'answer_verification' | 'language' | 'classification' | 'solution'
    suggestion_text TEXT NOT NULL,
    confidence FLOAT,
    status TEXT DEFAULT 'pending',                 -- 'pending' | 'accepted' | 'rejected'
    reviewed_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

-- ==================== INDEXES ====================

CREATE INDEX idx_questions_subject ON questions(subject_id);
CREATE INDEX idx_questions_chapter ON questions(chapter_id);
CREATE INDEX idx_questions_topic ON questions(topic_id);
CREATE INDEX idx_questions_type ON questions(question_type_id);
CREATE INDEX idx_questions_difficulty ON questions(difficulty_level_id);
CREATE INDEX idx_questions_source ON questions(source_id);
CREATE INDEX idx_questions_parent ON questions(parent_question_id);
CREATE INDEX idx_questions_active ON questions(is_active);
CREATE INDEX idx_questions_text_search ON questions USING GIN (to_tsvector('english', question_text));
CREATE INDEX idx_question_history_qid ON question_history(question_id);
CREATE INDEX idx_question_batch ON question_batch_usage(batch_name);
CREATE INDEX idx_test_attempts_student ON test_attempts(student_id);
CREATE INDEX idx_test_attempts_test ON test_attempts(test_id);
CREATE INDEX idx_duplicate_pairs_status ON duplicate_pairs(status);
```

### 3.2 Row Level Security (RLS) Summary

| Table | Viewer | Editor | Metadata Admin | Admin |
|-------|--------|--------|----------------|-------|
| questions | SELECT | SELECT, INSERT, UPDATE | SELECT, INSERT, UPDATE | ALL |
| metadata tables | SELECT | SELECT | ALL | ALL |
| tests | SELECT own | ALL own | ALL own | ALL |
| test_attempts | Own only | Own only | Own only | ALL |
| user_profiles | Own only | Own only | Own only | ALL |
| question_history | SELECT | SELECT | SELECT | ALL |

---

## Phase 1 — Foundation & Core Infrastructure
**Priority**: 🔴 Critical  
**Estimated Duration**: 3-4 days  
**Dependencies**: None

### Goals
Set up the foundational project structure, Supabase integration, and core layout.

### Tasks

#### 1.1 Supabase Setup
- [ ] Create Supabase project
- [ ] Run database migration (all tables from schema above)
- [ ] Configure RLS policies
- [ ] Set up Supabase Storage bucket for images (`question-images`)
- [ ] Install `@supabase/supabase-js` and `@supabase/ssr`

#### 1.2 Project Structure
```
src/
├── app/
│   ├── layout.tsx              # Root layout with providers
│   ├── page.tsx                # Dashboard / home
│   ├── globals.css             # Global styles (exists)
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── callback/route.ts   # OAuth callback
│   ├── (dashboard)/
│   │   ├── layout.tsx          # Dashboard layout with sidebar
│   │   ├── browse/page.tsx     # Question browsing
│   │   ├── question/
│   │   │   ├── [id]/page.tsx   # Question detail view
│   │   │   └── new/page.tsx    # Create question
│   │   ├── test/
│   │   │   ├── page.tsx        # Test list
│   │   │   ├── builder/page.tsx
│   │   │   └── [id]/page.tsx   # Test detail
│   │   ├── import/page.tsx     # Bulk import
│   │   ├── analytics/page.tsx  # Dashboard & stats
│   │   ├── duplicates/page.tsx # Duplicate detection
│   │   └── settings/
│   │       ├── page.tsx        # General settings
│   │       ├── metadata/page.tsx
│   │       └── users/page.tsx  # Admin only
│   └── student/
│       ├── [testId]/page.tsx   # Student test-taking
│       └── results/[attemptId]/page.tsx
├── components/
│   ├── ui/                     # Reusable primitives
│   │   ├── Button.tsx
│   │   ├── Input.tsx
│   │   ├── Select.tsx
│   │   ├── Modal.tsx
│   │   ├── Badge.tsx
│   │   ├── Tooltip.tsx
│   │   ├── Toast.tsx
│   │   ├── Skeleton.tsx
│   │   ├── Pagination.tsx
│   │   └── ConfirmDialog.tsx
│   ├── layout/
│   │   ├── Sidebar.tsx
│   │   ├── Topbar.tsx
│   │   └── ThemeToggle.tsx
│   ├── question/
│   │   ├── QuestionCard.tsx        # Compact card for browse list
│   │   ├── QuestionDetail.tsx      # Full detail view with solution
│   │   ├── QuestionEditor.tsx      # Rich text editor form
│   │   ├── QuestionOptions.tsx     # Options editor/viewer
│   │   ├── QuestionHistory.tsx     # Edit history timeline
│   │   ├── MathRenderer.tsx        # MathJax wrapper
│   │   └── VideoPlayer.tsx         # Embedded video solution
│   ├── filter/
│   │   ├── FilterPanel.tsx         # Sidebar filter controls
│   │   ├── FilterChips.tsx         # Active filter display
│   │   ├── SavedFilters.tsx        # Saved filter presets
│   │   └── SearchBar.tsx
│   ├── test/
│   │   ├── TestBuilder.tsx
│   │   ├── TestPreview.tsx
│   │   ├── TestPDFExport.tsx
│   │   ├── TemplateSelector.tsx
│   │   └── BatchSelector.tsx
│   ├── import/
│   │   ├── FileUploader.tsx
│   │   ├── ImportPreview.tsx
│   │   └── AITaggingPanel.tsx
│   ├── analytics/
│   │   ├── StatsCards.tsx
│   │   ├── DistributionChart.tsx
│   │   └── UsageTracker.tsx
│   └── student/
│       ├── TestInterface.tsx
│       ├── Timer.tsx
│       ├── QuestionNavigator.tsx
│       └── ScoreReport.tsx
├── lib/
│   ├── supabase/
│   │   ├── client.ts           # Browser Supabase client
│   │   ├── server.ts           # Server Supabase client
│   │   └── middleware.ts       # Auth middleware
│   ├── api/
│   │   ├── questions.ts        # Question CRUD operations
│   │   ├── metadata.ts         # Metadata CRUD
│   │   ├── tests.ts            # Test operations
│   │   ├── users.ts            # User management
│   │   └── analytics.ts        # Analytics queries
│   ├── ai/
│   │   ├── gemini.ts           # Gemini API client
│   │   ├── classify.ts         # Auto-classify questions
│   │   ├── verify.ts           # Verify answers
│   │   ├── suggest.ts          # Language/solution suggestions
│   │   └── duplicates.ts       # Duplicate detection
│   ├── export/
│   │   ├── pdf.ts              # PDF generation
│   │   └── docx-import.ts      # Word file import/parse
│   ├── hooks/
│   │   ├── useQuestions.ts     # Question data hook
│   │   ├── useFilters.ts       # Filter state hook
│   │   ├── useAuth.ts          # Auth hook
│   │   ├── useKeyboard.ts     # Keyboard shortcuts
│   │   └── useDebounce.ts
│   └── utils/
│       ├── math.ts             # MathJax helpers
│       ├── format.ts           # Formatting utilities
│       └── constants.ts
├── types/
│   └── index.ts                # All TypeScript types (exists, needs update)
└── middleware.ts               # Next.js middleware for auth
```

#### 1.3 Core Layout & Navigation
- [ ] Implement root `layout.tsx` with theme provider, Supabase provider, toast provider
- [ ] Build **Sidebar** component with sections:
  - 📊 Dashboard (analytics overview)
  - 🔍 Browse Questions
  - ✏️ Create Question
  - 📥 Import Questions (Editor+)
  - 📝 Test Generator
  - 🔄 Duplicates (Editor+)
  - ⚙️ Settings
  - 👤 User Profile
- [ ] Build **Topbar** with search bar, theme toggle, user menu
- [ ] Implement dark/light theme toggle (persisted in localStorage)
- [ ] Create all reusable UI primitives (Button, Input, Modal, Badge, etc.)

#### 1.4 Data Migration
- [ ] Write migration script to import existing JSON data into Supabase
- [ ] Map existing string-based metadata to UUID-referenced rows
- [ ] Verify data integrity post-migration

### Verification
- [ ] Supabase connection works (read/write from Next.js)
- [ ] Sidebar navigation renders correctly in both themes
- [ ] All UI primitives render and function (manual check)
- [ ] Responsive layout works on mobile/tablet/desktop

---

## Phase 2 — Question Browsing & Filtering
**Priority**: 🔴 Critical  
**Estimated Duration**: 4-5 days  
**Dependencies**: Phase 1

### Goals
Build the primary question browsing experience with powerful filtering, search, pagination, and MathML rendering.

### Tasks

#### 2.1 Question List View (`/browse`)
- [ ] **QuestionCard** component:
  - Shows question text (truncated, with MathML rendered)
  - Metadata badges: subject, chapter, difficulty, type, source
  - Custom tags displayed as colored chips
  - Click to expand → shows full question, options, solution, video player, and all metadata
  - Visual indicator for linked/paragraph questions (grouped with parent)
- [ ] **Pagination**: Server-side pagination (50 questions per page) with page numbers
- [ ] **Sort options**: By date created, difficulty, subject, chapter
- [ ] **Bulk selection**: Checkbox on each card for bulk operations (delete, tag, add to test)

#### 2.2 Filter Panel
- [ ] **Cascading filters**: Subject → Chapter → Topic → Subtopic (selecting a subject auto-loads its chapters, etc.)
- [ ] **Multi-select** for: subjects, chapters, topics, question types, difficulty levels, sources, exams, custom tags
- [ ] **Text search**: Full-text search across question_text, solution_text, topic, chapter (using PostgreSQL `tsvector`)
- [ ] **Active filter chips**: Show selected filters as removable chips above the question list
- [ ] **Clear all filters** button
- [ ] **Saved filters**: Save/load/delete filter presets (per user, stored in `saved_filters` table)

#### 2.3 Question Detail View (`/question/[id]`)
- [ ] Full question text with MathML rendered via MathJax
- [ ] Options displayed with correct answer highlighted
- [ ] Solution text with MathML
- [ ] Video solution player (embedded iframe)
- [ ] Complete metadata panel
- [ ] Edit history timeline (who changed what, when)
- [ ] Navigation: Previous/Next question (within current filter results)
- [ ] Actions: Edit, Delete, Duplicate, Add to Test, Add Tags

#### 2.4 MathML / LaTeX Rendering
- [ ] **MathRenderer** component wrapping MathJax 3
- [ ] Auto-typeset on content change
- [ ] Handle both MathML and LaTeX in same content
- [ ] Properly render in both light and dark themes

#### 2.5 Linked Questions
- [ ] Group paragraph-based questions under their parent
- [ ] Parent question (passage) shown as a collapsible header
- [ ] Child questions shown indented underneath
- [ ] Filter by parent → shows all children

#### 2.6 Keyboard Shortcuts
- [ ] `J` / `K` — Move to next/previous question in list
- [ ] `Enter` — Expand/collapse selected question
- [ ] `E` — Edit selected question
- [ ] `S` — Toggle solution visibility
- [ ] `F` — Focus search bar
- [ ] `/` — Open filter panel
- [ ] `Esc` — Close modals/panels
- [ ] Keyboard shortcuts help modal (`?`)

### Verification
- [ ] Filter by subject → only shows that subject's questions
- [ ] Cascading filters work (selecting Physics → shows Physics chapters only)
- [ ] Search finds questions containing the search term (including in math content)
- [ ] Pagination correctly pages through results
- [ ] MathML renders correctly in question text, options, and solutions
- [ ] Linked questions are properly grouped
- [ ] Keyboard shortcuts all function correctly
- [ ] Saved filters persist across sessions
- [ ] Performance: page loads in <2s with 1000+ questions

---

## Phase 3 — Question CRUD & Rich Editor
**Priority**: 🔴 Critical  
**Estimated Duration**: 5-6 days  
**Dependencies**: Phase 2

### Goals
Enable full question lifecycle management with a rich text editor, bulk import, and edit history.

### Tasks

#### 3.1 Rich Text Editor (TipTap-based)
- [ ] **TipTap editor** with extensions:
  - Bold, italic, underline, strikethrough
  - Subscript, superscript
  - Ordered/unordered lists
  - Image upload (to Supabase Storage)
  - **MathML/LaTeX insertion** (modal with preview)
  - Tables (for matrix match questions)
  - Code blocks (for numerical problems)
  - Undo/redo
- [ ] **Math input modal**: Type LaTeX, see live preview, insert as MathML
- [ ] **Image upload**: Drag-drop or file picker → upload to Supabase Storage → insert URL
- [ ] **Editor for both question text and solution text**

#### 3.2 Question Create Form (`/question/new`)
- [ ] Rich text editor for question text
- [ ] Dynamic options editor:
  - SCQ: 4 options, one correct (radio)
  - MCQ: 4+ options, multiple correct (checkbox)
  - Integer: single numeric answer field
  - Matrix Match: grid editor
- [ ] Rich text editor for solution text
- [ ] Metadata selectors: subject, chapter, topic, subtopic, source, difficulty, exam, class level
- [ ] Custom tags multi-select with create-new option
- [ ] Parent question selector (for linked questions)
- [ ] Video solution URL field
- [ ] Preview mode: see rendered question before saving
- [ ] Save as draft / Publish

#### 3.3 Question Edit Form (`/question/[id]/edit`)
- [ ] Same form as create, pre-populated with existing data
- [ ] **Diff view**: show what changed before saving
- [ ] Auto-save draft to localStorage
- [ ] On save: record changes to `question_history` table

#### 3.4 Bulk Import (`/import`)
- [ ] **File upload**: Accept `.docx` and `.pdf` files
- [ ] **Parser**: Extract questions from uploaded files
  - Detect question numbers, options (A/B/C/D), answer keys, solutions
  - Handle MathML/LaTeX in Word equations
  - Extract embedded images → upload to Supabase Storage
- [ ] **Import preview**: Show parsed questions in a table
  - User can review, edit, approve/reject each question
  - AI-suggested metadata tags shown (see Phase 6)
- [ ] **Bulk metadata assignment**: Apply same subject/chapter/topic/source to all imported questions
- [ ] **Import progress**: Show progress bar during import
- [ ] **Import history**: Log of past imports with counts

#### 3.5 Bulk Operations
- [ ] **Bulk delete**: Select multiple → delete (with confirmation)
- [ ] **Bulk tag**: Select multiple → add/remove tags
- [ ] **Bulk re-categorize**: Select multiple → change subject/chapter/topic
- [ ] **Bulk export**: Select multiple → export as JSON

#### 3.6 Edit History
- [ ] **Timeline view** on question detail page
- [ ] Each entry shows: user avatar, name, timestamp, what changed
- [ ] Click to see diff (old value vs new value)
- [ ] **Restore** to any previous version

### Verification
- [ ] Create a new question with MathML → saves correctly, renders on browse page
- [ ] Edit a question → changes reflected, history entry created
- [ ] Delete a question → soft deleted, no longer appears in browse (but history preserved)
- [ ] Import a Word file → questions extracted, metadata suggested, saved to DB
- [ ] Bulk operations work on 50+ questions simultaneously
- [ ] Rich text editor handles MathML, images, and formatting correctly
- [ ] Edit history shows correct diffs and allows restore

---

## Phase 4 — Authentication & Role-Based Access
**Priority**: 🟡 High  
**Estimated Duration**: 2-3 days  
**Dependencies**: Phase 1

> **Note**: Can be developed in parallel with Phase 2/3. Stub auth can be used during development.

### Tasks

#### 4.1 Supabase Auth Setup
- [ ] Configure Google OAuth provider in Supabase (no domain restriction)
- [ ] Configure email/password auth as fallback
- [ ] Create auth callback route (`/auth/callback`)
- [ ] Set up Next.js middleware to protect routes

#### 4.2 Login Page
- [ ] Google OAuth "Sign in with Google" button
- [ ] Email/Password login form
- [ ] Redirect to dashboard after login
- [ ] "Remember me" functionality

#### 4.3 User Profile
- [ ] Auto-create `user_profiles` entry on first login (role: `viewer` by default)
- [ ] Profile page: name, email, avatar, role (read-only for non-admins)
- [ ] User preferences: theme, default filters, items per page

#### 4.4 Role-Based Access Control
- [ ] **Middleware**: Check user role before allowing access to protected routes
- [ ] **UI enforcement**: Hide/disable buttons based on role
  - Viewer: no edit/delete/create buttons visible
  - Editor: no metadata management
  - Metadata Admin: no user management
- [ ] **API enforcement**: Server-side role checks on all mutations
- [ ] **RLS policies**: Supabase RLS for defense-in-depth

#### 4.5 User Management (Admin)
- [ ] `/settings/users` page (Admin only)
- [ ] List all users with roles
- [ ] Change user roles
- [ ] Activate/deactivate users
- [ ] Invite new users via email

### Verification
- [ ] Google OAuth login works (any domain)
- [ ] User profile auto-created with `viewer` role
- [ ] Viewer cannot see edit/delete buttons
- [ ] Editor can create/edit questions but cannot manage metadata
- [ ] Admin can manage users, change roles
- [ ] Unauthorized API calls return 403
- [ ] RLS prevents direct DB access violations

---

## Phase 5 — Test Generation & PDF Export
**Priority**: 🟡 High  
**Estimated Duration**: 5-6 days  
**Dependencies**: Phase 2, Phase 3

### Goals
Build a powerful test creation workflow with templates, auto-generation, batch tracking, and high-quality PDF export.

### Tasks

#### 5.1 Test Templates
- [ ] **Preset templates** stored in `test_templates` table:
  - JEE Mains Full Test (90 questions: 30P + 30C + 30M, specific type distribution)
  - JEE Advanced Paper 1 / Paper 2
  - NEET Full Test
  - Chapter-wise Test (configurable)
  - Custom (fully user-defined)
- [ ] Template editor: create/edit custom templates
- [ ] Template config: duration, marks scheme (positive/negative), section breakdown

#### 5.2 Test Builder (`/test/builder`)
- [ ] **Step 1 — Template or Custom**: Choose a template or start from scratch
- [ ] **Step 2 — Configuration**: Set title, subtitle, date, duration, marking scheme
- [ ] **Step 3 — Question Selection**:
  - **Manual**: Browse/filter questions and add to sections
  - **Auto-generate**: Specify criteria per section:
    - Subject, chapters, topics
    - Number of questions per type (SCQ, MCQ, Integer, etc.)
    - Difficulty distribution (e.g., 40% easy, 40% medium, 20% hard)
    - Exclude questions used in specific batches
    - AI fills the selection based on criteria
  - **Mixed**: Start with auto-generate, then manually swap/add/remove
- [ ] **Step 4 — Review**: Preview the full test
  - Reorder questions via drag-and-drop
  - See question distribution stats
  - Check for duplicate questions
- [ ] **Step 5 — Finalize**: 
  - Enter batch name → recorded in `question_batch_usage`
  - Questions marked as used in that batch
  - Generate shareable link (if desired)
  - Export as PDF

#### 5.3 Batch Tracking
- [ ] When a test is finalized with a batch name:
  - All question IDs recorded in `question_batch_usage` with the batch name
  - Future auto-generation for the same batch will exclude these questions
- [ ] Batch management page: view all batches, see which questions were used
- [ ] Filter: "Show only questions NOT used in batch X"

#### 5.4 PDF Export
- [ ] **Professional PDF layout**:
  - **Page 1**: Test header (title, subtitle, date, duration, marks info)
  - **Page 2**: Instructions (customizable HTML)
  - **Questions section**: 
    - Properly numbered questions with rendered MathML
    - Options formatted as (A), (B), (C), (D)
    - Images embedded
    - Section headers between subjects
    - Paragraph/linked questions: passage shown once, sub-questions below
  - **Answer Key section**: Table format — Q1: (A), Q2: (B,D), Q3: 42, etc.
  - **Solutions section**: Full solutions with MathML rendered
- [ ] **PDF styling**: Clean, print-optimized typography
- [ ] **Page numbers** and **watermark** support (optional)
- [ ] **Download** as PDF file
- [ ] **Shareable link**: Anyone with link can view/download (no auth required)

#### 5.5 Test Management (`/test`)
- [ ] List all tests (with filters: status, batch, date)
- [ ] View test details
- [ ] Edit draft tests
- [ ] Duplicate a test
- [ ] Delete tests
- [ ] Share/unshare tests

### Verification
- [ ] Create test from JEE Mains template → correct section structure
- [ ] Auto-generate fills questions matching criteria
- [ ] Batch tracking excludes previously used questions
- [ ] PDF export: questions render correctly with MathML, images, proper formatting
- [ ] PDF has correct structure: Questions → Answer Key → Solutions
- [ ] Shareable link works for unauthenticated users
- [ ] Test status transitions (draft → finalized → shared) work correctly

---

## Phase 6 — AI-Powered Features
**Priority**: 🟠 Medium  
**Estimated Duration**: 4-5 days  
**Dependencies**: Phase 3

### Goals
Integrate Google Gemini/OpenAI/OpenRouter AI for intelligent question management: quality check, solution generation, and question modification.

**Current Status**: 
- ✅ AI Tools (QC, Solution, Modification) are fully implemented on the `/ai-tools` route.
- 🔒 AI Video Solution is pending (tab added but disabled).
- ✅ Question-wise AI features (AI Verify, Translation, dynamic model refresh, UI integration) are implemented.
- 🕒 Test-wise AI features are pending.

### Tasks

#### 6.1 Gemini API Integration
- [ ] Set up Gemini API client with API key (stored in env vars)
- [ ] Rate limiting and error handling
- [ ] Structured output parsing (JSON mode)
- [ ] Cost tracking / usage monitoring

#### 6.2 Auto-Classification (during import)
- [ ] When questions are imported, AI analyzes each question to suggest:
  - Subject
  - Chapter
  - Topic / Subtopic
  - Difficulty Level
  - Question Type
  - Exam relevance (JEE Mains/Advanced/NEET)
- [ ] Confidence score shown with each suggestion
- [ ] User can accept, modify, or reject each suggestion
- [ ] Batch classification for efficiency (send multiple questions in one API call)

#### 6.3 Answer Verification
- [ ] AI solves the question independently
- [ ] Compares AI answer with provided answer key
- [ ] If mismatch: flags question with warning, shows AI's working
- [ ] Verification status badge on question card (✅ Verified / ⚠️ Mismatch / ❓ Unverified)
- [ ] Bulk verify: run verification on filtered question set

#### 6.4 Language & Solution Suggestions
- [ ] AI reviews question text for:
  - Grammatical errors
  - Ambiguous wording
  - Missing information
  - Suggested improvements
- [ ] AI can generate/improve solution explanations:
  - Step-by-step solutions
  - Multiple solution approaches
  - Common mistakes to avoid
- [ ] Suggestions stored in `ai_suggestions` table
- [ ] User can accept (auto-apply) or reject suggestions

#### 6.5 AI Question Generation
- [ ] Generate new questions based on:
  - Topic/subtopic
  - Difficulty level
  - Question type
  - Reference question (generate similar)
- [ ] Generated questions placed in "AI Generated" review queue
- [ ] User reviews, edits, and approves before adding to bank

#### 6.6 Import AI Pipeline
- [ ] Full pipeline for bulk import:
  1. Parse file → extract raw questions
  2. AI classifies each question (subject, chapter, topic, difficulty)
  3. AI verifies each answer
  4. AI suggests language improvements
  5. User reviews all → approve/reject/edit
  6. Save approved questions to DB

### Verification
- [ ] Import a Word file → AI correctly classifies 80%+ of questions
- [ ] AI correctly verifies answers for standard JEE/NEET questions
- [ ] Language suggestions are relevant and helpful
- [ ] Generated questions are sensible and correctly formatted
- [ ] Bulk operations (classify, verify) handle 50+ questions without timeout
- [ ] AI suggestions UI allows easy accept/reject workflow

---

## Phase 7 — Analytics, Duplicates & Advanced Tools
**Priority**: 🟠 Medium  
**Estimated Duration**: 3-4 days  
**Dependencies**: Phase 2, Phase 5

### Tasks

#### 7.1 Analytics Dashboard (`/analytics`)
- [ ] **Overview cards**: Total questions, questions by status, recent additions
- [ ] **Distribution charts**:
  - Questions per subject (pie/donut chart)
  - Questions per chapter (bar chart, filterable by subject)
  - Questions per difficulty level
  - Questions per question type
  - Questions per source
- [ ] **Usage stats**:
  - Most used questions (across tests)
  - Questions never used in any test
  - Questions per batch
- [ ] **Team stats**:
  - Questions added per user (over time)
  - Edits per user
- [ ] **Trend**: Questions added over time (line chart)
- [ ] All charts interactive (click to filter/drill down)
- [ ] Use lightweight charting library (e.g., `recharts` or `chart.js`)

#### 7.2 Duplicate Detection (`/duplicates`)
- [ ] **Exact duplicate detection**: Find questions with identical `question_text` (after normalizing whitespace/formatting)
- [ ] **Similar question detection**: 
  - Text similarity using cosine similarity or Levenshtein distance
  - AI-powered semantic similarity (send pairs to Gemini)
  - Show similarity percentage
- [ ] **Duplicate review UI**:
  - Side-by-side comparison of potential duplicates
  - Actions: Merge (keep one, delete other), Dismiss (not a duplicate), Mark as variant
  - Merge retains the better version's metadata and history of both
- [ ] **Auto-detect on import**: Flag potential duplicates before saving new questions
- [ ] **Scheduled scan**: Option to scan entire bank for duplicates

#### 7.3 Advanced Search
- [ ] **Regex search** (power user feature)
- [ ] **Search within specific fields** (question only, solution only, options only)
- [ ] **Find questions by answer** (e.g., "show all questions where answer is 42")
- [ ] **Find questions by image** (has image / no image)

### Verification
- [ ] Dashboard shows accurate counts and charts
- [ ] Charts are interactive and drill down works
- [ ] Exact duplicates are correctly identified
- [ ] Similar questions are found with reasonable similarity scores
- [ ] Merge workflow preserves history of both questions
- [ ] Auto-detect prevents importing known duplicates
- [ ] Advanced search features return correct results

---

## Phase 8 — Student Test Mode
**Priority**: 🟢 Lower (but valuable)  
**Estimated Duration**: 4-5 days  
**Dependencies**: Phase 5

### Goals
Build a student-facing test interface with timer, navigation, auto-grading, and score reports.

### Tasks

#### 8.1 Test Access
- [ ] Students access tests via shareable link (e.g., `/student/[testId]`)
- [ ] Auth required (Google login, any domain)
- [ ] One attempt per student per test (configurable: allow/disallow retakes)
- [ ] Test availability window (optional: start time, end time)

#### 8.2 Test Interface (`/student/[testId]`)
- [ ] **Header**: Test title, timer (countdown), section tabs
- [ ] **Question display**: Full question with MathML rendered, options as selectable cards
- [ ] **Question navigation panel**: Grid of question numbers
  - Color coded: ✅ Answered, ⚪ Not visited, 🟡 Marked for review, 🔴 Not answered
- [ ] **Actions per question**: 
  - Select answer (click option)
  - Mark for review
  - Clear response
  - Save & Next
- [ ] **Section navigation**: Switch between sections (if multi-section test)
- [ ] **Auto-save**: Responses saved to server every 30 seconds
- [ ] **Submit**: Final submit with confirmation dialog
- [ ] **Timer expiry**: Auto-submit when time runs out

#### 8.3 Auto-Grading
- [ ] On submit, automatically grade the test:
  - Compare student responses with answer keys
  - Apply marking scheme (positive marks for correct, negative for incorrect)
  - Calculate section-wise and total scores
- [ ] Store results in `test_attempts` table

#### 8.4 Score Report (`/student/results/[attemptId]`)
- [ ] **Summary**: Total score, max score, percentage, rank (if multiple students)
- [ ] **Section-wise breakdown**: Score per section/subject
- [ ] **Question-wise analysis**:
  - Correct / Incorrect / Unattempted indicators
  - Show correct answer for incorrect responses
  - Show solution (optional: configurable by test creator)
  - Time spent per question
- [ ] **Performance insights**:
  - Topic-wise performance
  - Difficulty-wise accuracy
  - Comparison with average (if multiple students took same test)
- [ ] **Downloadable PDF** of score report

#### 8.5 Teacher Dashboard (Test Results)
- [ ] View all attempts for a test
- [ ] Student-wise results table (sortable by score, name, time)
- [ ] Question-wise analysis (which questions had lowest accuracy)
- [ ] Export results as CSV

### Verification
- [ ] Student can access test via link, log in, and start
- [ ] Timer counts down correctly, auto-submits on expiry
- [ ] Responses auto-save and persist on refresh
- [ ] Grading is correct for all question types (SCQ, MCQ, Integer)
- [ ] Score report shows accurate breakdown
- [ ] Teacher can view all results and export CSV
- [ ] Works well on both desktop and mobile

---

## Non-Functional Requirements

### Performance
| Metric | Target |
|--------|--------|
| Page load (browse) | < 2 seconds |
| Search response | < 500ms |
| PDF generation (30 questions) | < 10 seconds |
| AI classification (per question) | < 5 seconds |
| Concurrent users | 50+ |

### Accessibility
- Semantic HTML throughout
- ARIA labels on interactive elements
- Keyboard navigable (all core features)
- Color contrast ratio ≥ 4.5:1

### Security
- All mutations require authentication
- Role-based access enforced at API AND database level (RLS)
- XSS prevention: sanitize all HTML content
- CSRF protection via Supabase session tokens
- Rate limiting on AI endpoints

### Responsive Design
- Desktop-first design (primary use case)
- Tablet: sidebar collapses, cards stack
- Mobile: bottom navigation, simplified layout
- Student test mode: fully responsive (students may use phones)

---

## Deployment Strategy

### Development
```bash
npm run dev          # Local dev server on port 5174
```

### Staging
- Deploy to Vercel (free tier) for team review
- Connect to Supabase staging project

### Production
- Deploy to **AWS EC2** (or similar)
- Nginx reverse proxy
- PM2 process management
- Environment variables via `.env.production`
- Supabase production project (separate from staging)
- SSL via Let's Encrypt

### CI/CD
- GitHub Actions: lint → type-check → build on every PR
- Auto-deploy to staging on `main` merge
- Manual deploy to production

---

## Verification Strategy

### Per-Phase Verification
Each phase has specific verification criteria listed above. Before moving to the next phase:
1. All verification items must pass
2. Manual UI testing in both light and dark themes
3. Test on desktop + mobile viewport
4. Code review for TypeScript errors, proper error handling

### End-to-End Scenarios
After all phases:

1. **Full Question Lifecycle**: Import Word file → AI classifies → User reviews → Edit question → View history → Delete
2. **Test Generation Flow**: Create from template → Auto-fill questions → Exclude batch → Finalize → Export PDF → Share link
3. **Student Test Flow**: Student opens link → Logs in → Takes test → Timer expires → Grades → Views report → Teacher views results
4. **Duplicate Detection**: Import similar questions → System flags duplicates → User merges → Original's history preserved
5. **Role Enforcement**: Viewer tries to edit → blocked. Editor tries to manage metadata → blocked. Admin can do everything.
