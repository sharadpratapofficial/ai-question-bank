# PW Question Bank AI

## Model Card / AI System Card

## 1. Product overview

PW Question Bank AI is an AI-powered academic content workflow platform built for the PW AI Hackathon. It helps coaching teams digitize question papers, manage question banks, generate tests, verify answers and solutions, translate content into vernacular-ready formats, and analyze complete test papers for quality and syllabus balance.

Instead of treating AI as a chatbot, the product uses AI across the full academic content lifecycle:

- PDF to structured question-bank import
- AI verification of individual questions
- AI-generated solutions and suggestions
- AI translation and vernacular support
- AI question generation
- Full-paper verification and quality analysis
- Analytics for question-bank health and test coverage

## 2. Intended users

- Coaching institute content teams
- Faculty reviewers
- Academic heads
- Test paper setters
- Question bank managers
- Operations teams managing high test volume

## 3. Problem being solved

Academic teams spend large amounts of time on repetitive, expert-heavy work:

- typing questions from PDFs into structured databases
- checking answer keys manually
- writing or improving solutions
- balancing papers by syllabus and difficulty
- creating multilingual or vernacular-ready content
- identifying errors only after papers are already drafted

PW Question Bank AI reduces this manual workload while keeping a human review step in the loop.

## 4. AI-powered capabilities

### 4.1 PDF extraction

AI processes uploaded question papers and solution PDFs and converts them into structured question records with:

- question text
- options
- answer keys
- solution text
- metadata such as subject, chapter, topic, source, and difficulty

### 4.2 Question verification

AI can review a single question, solve it, compare the result with the current answer key, inspect the provided solution, and add:

- verification status
- AI solution
- AI suggestions
- quality comments

### 4.3 Translation and vernacular support

AI can translate academic content into a selected language to support broader student reach and local-language delivery.

### 4.4 AI question generation

Users can generate fresh questions by:

- exam type
- subject
- chapter
- topic
- question type
- difficulty

### 4.5 Full test verification

AI can analyze a complete test paper and create a quality report covering:

- wrong or suspicious questions
- answer mismatches
- missing question patterns
- syllabus imbalance
- out-of-syllabus detection
- paper-level suggestions

### 4.6 Analytics

The system surfaces analysis across the project and question bank, including:

- subject and chapter spread
- difficulty distribution
- question type mix
- metadata completeness
- AI verification coverage
- usage versus unused content

## 5. Model providers

This system is model-agnostic and supports multiple providers based on configured API access. Depending on the workflow, the product may use providers such as:

- Gemini
- OpenAI
- Anthropic
- OpenRouter
- Groq
- Grok

The product does not depend on one fixed model only. Instead, it allows provider and model selection for different AI-assisted workflows.

## 6. Inputs

Typical inputs include:

- scanned or digital PDFs
- question text
- option sets
- answer keys
- solution text
- exam type
- subject, chapter, topic, and subtopic metadata
- language selection for translation
- test-generation configuration

## 7. Outputs

Typical outputs include:

- extracted structured questions
- AI-generated or improved solutions
- verification results
- flagged issues and suggestions
- translated question/solution content
- generated practice questions
- full-paper quality reports
- question-bank analytics

## 8. Human oversight

This is a human-in-the-loop academic workflow product.

Users can:

- review extracted questions before saving
- edit question text, options, and metadata
- inspect AI verification outputs
- override AI suggestions
- manually finalize tests before external use

AI helps speed up expert work, but does not replace academic review.

## 9. Evaluation approach

The product is evaluated on practical utility rather than benchmark-only accuracy.

Primary evaluation dimensions:

- extraction usefulness
- verification usefulness
- solution quality usefulness
- translation usefulness
- question generation usefulness
- full-paper QC usefulness
- time saved versus manual workflow

Suggested measurable metrics:

- time to import 1 paper
- time to verify 10 questions
- time to generate a chapter test
- number of answer mismatches caught
- number of content issues surfaced
- user satisfaction score

## 10. Known limitations

- low-quality scans may reduce extraction quality
- OCR-heavy PDFs may produce formatting errors
- AI verification may not always match faculty-standard reasoning
- translation quality can vary by subject and language
- generated questions may need academic polishing
- syllabus-balance judgments depend on correct metadata tagging

## 11. Risks

- false positive or false negative verification
- hallucinated solution steps
- inaccurate metadata extraction
- translation of technical terms into weaker wording
- over-trust in AI output without faculty review

## 12. Mitigations

- human review before final publishing
- editable extracted and generated content
- explicit verification tags instead of silent replacement
- provider/model selection flexibility
- full-paper reports to surface suspicious content

## 13. Privacy and safety notes

- academic content is processed only for workflow support
- users can manage provider API keys
- the product should be used with institute-approved content governance and review practices
- no claim is made that AI output alone is final academic truth

## 14. Recommended positioning line

PW Question Bank AI is an academic content operations system that uses AI to reduce manual effort in PDF import, question verification, solution improvement, translation, question generation, and full-paper quality analysis for coaching institutes.
