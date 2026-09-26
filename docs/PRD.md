# Product Requirements Document

## Product

AI Question Bank is a PW AI Hackathon MVP for coaching institutes and academic content teams. It helps teams build, manage, verify, translate, generate, analyze, and export exam-ready question papers with AI-assisted workflows.

Live demo: https://aiquestionbank.netlify.app

## Problem

Coaching teams spend a large amount of time on repetitive academic operations:

- Manually importing questions from PDFs.
- Checking answer keys and solutions question by question.
- Creating balanced test papers across subjects, chapters, topics, difficulty, and question types.
- Translating or rewriting content for vernacular learners.
- Preparing printable papers and answer keys in consistent formats.
- Reviewing test quality, syllabus balance, and metadata coverage.

These tasks are slow, error-prone, and difficult to scale across large question banks.

## Target Users

- Coaching institute academic teams.
- Faculty and paper setters.
- Content operations teams.
- Quality-control reviewers.
- Test-prep administrators.

## Core Value Proposition

The product reduces manual academic busywork by using AI and structured metadata to create faster, cleaner, and more reliable question-bank and test-paper workflows.

## Key Features

### AI Bulk Import From PDFs

Users can upload question and solution PDFs. AI extracts questions, options, answer keys, solutions, and metadata so the team can review and save them into the question bank.

### AI Question Verification

AI can solve a question, verify the stored answer key, improve or validate the solution, and flag issues. Verified questions can show an AI-verified status with suggestions and solution data.

### AI Question Generation

Users can generate fresh questions by exam, subject, chapter, topic, question type, and difficulty. This helps content teams quickly fill gaps in practice material.

### AI Translation and Vernacular Support

AI can translate or rewrite academic content into vernacular-ready language so coaching teams can support students in the language they learn best.

### Test Paper Generation

Users can generate structured papers for JEE Main, JEE Advanced, NEET, or custom tests using metadata filters and distribution rules.

### Full Test Verification and Analysis

The product supports full-paper quality checks, including answer verification, wrong-question detection, syllabus balance, difficulty balance, out-of-syllabus risk, and actionable suggestions.

### Analytics Dashboard

The analytics area shows useful product and content insights, including question-bank coverage, subject/chapter distribution, difficulty balance, source coverage, verification health, and test composition quality.

### Print-Ready Save and Preview

After generating a test, users can open a clean final paper preview for printing. The final preview hides editing controls so the paper can be used directly for print or export.

### PDF Export

Users can download generated test papers as PDFs. PDF export should respect the selected on-screen paper configuration, including:

- Paper-wise or question-wise layout.
- Two-column format when selected.
- Selected metadata fields such as subject, chapter, topic, difficulty, source, question type, exam, class level, question ID, and QBG ID.
- Math and equation visibility.
- Clean answer and solution sections without distracting colored UI boxes.
- Print-friendly spacing and column separation.

## Recent Product Updates

- Added direct PDF download instead of opening the browser print screen.
- Improved two-column PDF output with explicit left and right columns, better spacing, and a center divider.
- Added selected metadata fields into PDF export.
- Improved PDF math rendering using KaTeX styling, MathML handling, and equation-image fallbacks.
- Made paper-wise solutions follow the selected two-column format.
- Removed the pencil edit icon from the final Save & Preview paper screen to keep the generated paper print-ready.
- Updated default JEE Main instructions with General Instructions and OMR Instructions.
- Previously generated tests now reopen in the full final-format screen with saved export settings restored, including option labels, one/two-column layout, ordering, content selection, metadata, and instructions.
- Added saved-test deletion from the Tests history screen without deleting original question-bank questions.

## Success Metrics

- Time saved in creating a paper compared with manual paper creation.
- Reduction in answer-key and solution errors after AI verification.
- Number of imported questions reviewed and saved per hour.
- Percentage of generated papers with balanced syllabus and difficulty distribution.
- Faculty satisfaction during alpha/beta trials.
- Number of issues caught before print or student use.

## MVP Scope

The MVP should demonstrate:

- Live product demo with question-bank, AI, test generation, and export workflows.
- AI-assisted import, generation, verification, translation, and full-test analysis.
- Printable final paper preview.
- Downloadable paper outputs.
- Hackathon submission assets including model card, ROI one-pager, and alpha/beta test log template.

## Out of Scope For MVP

- Full institutional ERP integration.
- Large-scale proctored student test-taking.
- Automated payment or subscription management.
- Offline desktop app packaging.

## Risks and Mitigations

- AI can make mistakes: keep human review and verification status visible.
- PDF rendering can differ from browser preview: use explicit PDF layout structures and math rendering fallbacks.
- Poor metadata quality reduces test balancing: show metadata coverage and allow selected fields to be reviewed.
- Remote equation images may fail if blocked by CORS and contain no recoverable alt/latex data: prefer MathML, LaTeX, or embedded image data during import.

## Hackathon Positioning

This product is built for the PW AI Hackathon. It focuses on measurable academic operations impact: faster paper creation, fewer content errors, better test quality, and reduced repetitive faculty effort.
