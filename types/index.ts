// ── Interview state machine ───────────────────────────────────────────────
// Use these constants everywhere — never compare to raw strings.
export const InterviewState = {
  IDLE:             'IDLE',
  PLAYING_QUESTION: 'PLAYING_QUESTION',
  READY:            'READY',
  RECORDING:        'RECORDING',
  REVIEWING:        'REVIEWING',
  SUBMITTING:       'SUBMITTING',
  FEEDBACK:         'FEEDBACK',
  BREAK:            'BREAK',
} as const;

export type InterviewState = typeof InterviewState[keyof typeof InterviewState];

// ── Domain types ──────────────────────────────────────────────────────────
export type PresetRoom = 'data_engineering' | 'data_science' | 'ml_engineering';
export type Room       = PresetRoom | 'custom';

export type CoachingMode = 'active' | 'passive';

export const VALID_ROOMS: Room[] = [
  'data_engineering',
  'data_science',
  'ml_engineering',
  'custom',
];

export function isValidRoom(value: string): value is Room {
  return VALID_ROOMS.includes(value as Room);
}

export function isPresetRoom(r: Room): r is PresetRoom {
  return r !== 'custom';
}

// ── Entity interfaces (mirror DB schema exactly) ──────────────────────────
export interface Session {
  id:              string;
  user_id:         string;
  room:            Room;
  persona_id:      string;
  status:          'active' | 'paused' | 'completed';
  coaching_mode:   CoachingMode;
  question_count:  number;
  topic:           string | null;
  job_description: string | null;
  skip_intro:      boolean;
  voice_enabled:   boolean;
  started_at:      string;
  ended_at:        string | null;
}

export interface Question {
  id:            string;
  session_id:    string;
  question_text: string;
  best_answer:   string;
  question_type: 'intro' | 'domain';
  order_index:   number;
  asked_at:      string;
}

export interface Answer {
  id:                 string;
  question_id:        string;
  transcript:         string;
  viewed_best_answer: boolean;
  used_best_answer:   boolean;
  feedback_text:      string | null;
  submitted_at:       string;
}

// ── Learning goals (dashboard) ────────────────────────────────────────────
// Status of the Kanban track that is generated for a goal in the background.
// 'awaiting_approval' is document-sourced goals only: the extract step lands
// here so the learner can review the candidate topic/tips before generation
// fires (see PRD-course-from-document.md).
export type TrackStatus = 'pending' | 'ready' | 'failed' | 'awaiting_approval';

// Where a goal's topic came from: the Socratic refinement loop, or an
// uploaded document.
export type SourceKind = 'qa' | 'document';

export interface LearningGoal {
  id:           string;
  user_id:      string;
  topic:        string;
  start_date:   string;
  end_date:     string;
  track_status: TrackStatus;
  source_kind:  SourceKind;
  created_at:   string;
  // When the current track build started. Null on rows written before
  // migration 046 — read it as `track_started_at ?? created_at`.
  track_started_at: string | null;
  // Which region of the learner's map this goal is filed under (migration 051),
  // assigned by the topic gate. Null on every goal created before it, and on
  // any the gate could not honestly place — an unfiled goal lights nothing.
  region: string | null;
}

// One 5-whys question and the learner's answer to it, as stored by migration
// 048. `position` is the order asked and carries meaning: the prompt digs one
// level deeper each turn, so answer 4 is not answer 0.
//
// This is the most personal text in the product. The questions are generated
// to draw out real motivation and circumstance, so the answers are career
// situations — the sort of thing a learner may be keeping from an employer.
// The learner can read them back and delete them from their goal card; see
// components/dashboard/GoalAnswers.tsx.
export interface StoredAnswer {
  position: number;
  question: string;
  answer:   string;
}

// ── Progress Tracker ──────────────────────────────────────────────────────
export type KanbanColumn = 'backlog' | 'learn' | 'review' | 'done';

export const KANBAN_COLUMNS: KanbanColumn[] = ['backlog', 'learn', 'review', 'done'];

export const KANBAN_COLUMN_LABELS: Record<KanbanColumn, string> = {
  backlog: 'Backlog',
  learn:   'Learning',
  review:  'Review',
  done:    'Mastered',
};

export type BacklogPriorityMode = 'auto' | 'manual';

export interface Track {
  id:                    string;
  user_id:               string;
  goal_id:               string | null;
  title:                 string;
  topic_description:     string;
  status:                'active' | 'paused' | 'completed';
  focus_milestone_id:    string | null;
  backlog_priority_mode: BacklogPriorityMode;
  created_at:            string;
}

// A single "thing to understand" derived from a milestone's goal.
export interface LearningPoint {
  id:   string;
  text: string;
}

/**
 * What `/api/tracker/milestones/[id]/coverage` returns.
 *
 * `learningPoints` is absent on the failure path, and that absence is NOT an
 * empty checklist: the list is generated by a model on first open, and a
 * response that failed validation is written nowhere. Every reader has to
 * branch on the response status, or it will render "this card has no key
 * ideas" over a card whose checklist simply could not be built.
 */
export interface CoverageResponse {
  learningPoints?: LearningPoint[];
  coverage?:       unknown;
  error?:          string;
}

// Self-assessment status for a single learning point. Absent from the map =
// unstarted. Purely the learner's own awareness flag — never gates mastery.
export type PointStatus = 'understood' | 'bookmarked' | 'stuck';

// Per-milestone self-assessment: each learning point id mapped to its status.
export interface MilestoneCoverage {
  statuses:  Record<string, PointStatus>;
  updatedAt: string;
}

export interface Milestone {
  id:                string;
  track_id:          string;
  title:             string;
  summary:           string;
  kanban_column:     KanbanColumn;
  position:          number;
  review_validated:  boolean;
  mastery_validated: boolean;
  mastery_score:     number | null;
  learning_points:   LearningPoint[] | null;
  coverage:          MilestoneCoverage | null;
  priority_rank:     number | null;
  priority_reason:   string | null;
  mastery_feedback:  string | null;
  summary_doc:       string | null;
  summary_doc_at:    string | null;
  created_at:        string;
}

export type FactStatus = 'pending' | 'correct' | 'incorrect';

// One substantive thing actually established during a learning session — the
// claim itself, not a note that the subject came up. `body` narrates the shape
// of a conversation ("the student explored dot products"); this records what was
// established ("a feature vector and a weight vector must match in length…").
// It is what review quizzes are generated from, so a quiz can only ask about
// material the learner genuinely covered.
export interface CoveredPoint {
  point:  string;
  detail: string;
}

// A message as stored on an entry's transcript — the session that produced it.
export interface TranscriptMessage {
  role:    'user' | 'assistant';
  content: string;
}

export interface MilestoneEntry {
  id:           string;
  milestone_id: string;
  user_id:      string;
  title:        string | null;
  body:         string;
  fact_status:  FactStatus;
  correction:   string | null;
  gap_note:     string | null;
  corrected:    boolean;
  // Optional tag to one of the milestone's learning points (a LearningPoint.id
  // from learning_points JSONB). null = untagged / general entry.
  point_id:     string | null;
  // Soft-archive: null = active (shown by default), a timestamp = archived
  // (hidden behind "Show archived", restorable). Entries are never hard-deleted.
  archived_at:  string | null;
  // What the session actually established, and the session itself. Both null on
  // entries written by hand and on everything saved before migration 035.
  // `transcript` is optional because the diary list endpoint deliberately does
  // not fetch it — it is large and nothing in that view reads it.
  covered:      CoveredPoint[] | null;
  transcript?:  TranscriptMessage[] | null;
  created_at:   string;
}

// Track with milestone counts precomputed — used on the dashboard.
export interface TrackWithStats extends Track {
  milestones: Pick<Milestone, 'id' | 'kanban_column'>[];
}

// ── Realtime Mastery session (OpenAI Realtime coach) ──────────────────────
// The Realtime model CONDUCTS the spoken assessment; the app owns every piece
// of truth below. The final result is produced by a grounded Sonnet evaluation,
// never by the Realtime model.

// Why a Realtime conversation ended. Passed to the evaluator so scoring can
// account for a truncated discussion.
export type MasteryEndReason =
  | 'coach_concluded'  // the coach called conclude_assessment
  | 'max_followups'    // app cap on number of follow-up turns
  | 'max_duration'     // app cap on session length
  | 'inactivity'       // no speech for the inactivity window
  | 'user_ended';      // learner ended the session

// Outcome bucket. `passed` (mastery_validated) is still gated on masteryScore ≥ 7;
// masteryStatus is the human-facing bucket.
export type MasteryStatus = 'mastered' | 'developing' | 'not_yet';

// The structured evaluation persisted (JSON-serialised) into milestones.mastery_feedback.
// VERSIONED so the UI can evolve the schema without breaking historical records.
// Deliberately concise — supportingTranscriptEvidence holds short grounded
// excerpts, NEVER the full transcript (which is not persisted).
export interface MasteryResultV1 {
  version:                      1;
  masteryStatus:                MasteryStatus;
  masteryScore:                 number;        // 1–10
  strengths:                    string[];
  misconceptions:               string[];
  missingConcepts:              string[];
  recommendedReview:            string[];
  suggestedNextStep:            string;
  supportingTranscriptEvidence: string[];      // short quotes / turn references
}

// One turn of the captured spoken conversation (sent to the evaluator).
export interface MasteryTranscriptTurn {
  role: 'coach' | 'learner';
  text: string;
}

// Connection lifecycle for the Realtime mastery coach.
export type MasteryRealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'coach_speaking'
  | 'listening'
  | 'thinking'      // model composing its spoken reply
  | 'concluding'    // ending → evaluation about to run
  | 'error'
  | 'disconnected';

export type MasteryRealtimeErrorKind = 'mic_permission' | 'connection' | 'unsupported';

export interface MasteryRealtimeError {
  kind:    MasteryRealtimeErrorKind;
  message: string;
}

// Turn-detection settings echoed to the client so it re-asserts the SAME
// (noise-robust) VAD config the session was minted with.
export interface MasteryTurnDetection {
  type:                 string;
  threshold?:           number;
  prefix_padding_ms?:   number;
  silence_duration_ms?: number;
  create_response:      boolean;
  interrupt_response:   boolean;
}

// Server-created WebRTC call. No browser credential or provider call ID.
export interface MasteryRealtimeCredentials {
  sessionId:             string;
  answerSdp:             string;
  model:                 string;
  voice:                 string;
  transcriptionModel:    string;
  transcriptionLanguage: string;
  turnDetection:         MasteryTurnDetection;
  maxSessionSeconds:     number;
  maxFollowups:          number;
  inactivityMs:          number;
}

// ── Notes workspace ───────────────────────────────────────────────────────
// Screenshot-driven learning notes with a per-note Coach chat. Mirrors the
// tables in migration 027_notes.sql. All personal (one owner per row).

// Nesting + the Bag are shared by both levels of the tree (see migration
// 034_notes_grouping.sql). A row with `is_group` is a container: it holds
// children and nothing else. `parent_id` only ever points at such a container.
// `bagged_at` non-null means "tucked away" — hidden from the tree, listed in
// the Bag drawer, restorable in place.
interface TreeRowFields {
  parent_id: string | null;
  is_group:  boolean;
  bagged_at: string | null;
}

// A tree branch — e.g. "GCP Data Engineer" — or, with is_group, a folder
// holding notebooks and other folders to any depth.
export interface Notebook extends TreeRowFields {
  id:         string;
  user_id:    string;
  title:      string;
  position:   number;
  created_at: string;
  updated_at: string;
}

// A leaf under a notebook — "Untitled" until renamed. Pages group freely among
// themselves, but `notebook_id` never changes: a page is always bounded by its
// notebook, however deeply it is nested.
export interface Note extends TreeRowFields {
  id:          string;
  user_id:     string;
  notebook_id: string;
  title:       string;
  position:    number;
  created_at:  string;
  updated_at:  string;
}

// An uploaded screenshot. `title` is a renameable label (default "Screenshot N").
// `url` is a short-lived signed URL the API resolves at read time from
// `storage_path`; it is never persisted. `flag` is a manual red/yellow/green
// signal the learner stamps on it (e.g. red = still shaky) — a label only,
// nothing reads it for scoring.
export type NoteImageFlag = 'red' | 'yellow' | 'green';

// `parent_image_id` is what makes a tall question capturable: a screenshot too
// long for one snip is stored as a bucket (parent_image_id null — it owns the
// title, the flag and the thread) plus extra snips hanging off it, stacked in
// `position` order. Parts nest exactly one level; a part never has parts.
export interface NoteImage {
  id:              string;
  note_id:         string;
  title:           string;
  storage_path:    string;
  mime:            string;
  created_at:      string;
  url:             string | null;
  flag:            NoteImageFlag | null;
  parent_image_id: string | null;
  position:        number;
}

// What the workspace actually works with: one screenshot slot and every snip in
// it. `parts` is empty for the ordinary single-snip case.
export interface NoteImageBucket extends NoteImage {
  parts: NoteImage[];
}

// The most snips one bucket may hold. Each part is inlined as base64 into the
// Coach request, so this is a cost and latency ceiling, not an arbitrary cap.
export const MAX_BUCKET_PARTS = 4;

// One line in a screenshot's chat thread. `user` = the learner's own thoughts,
// `assistant` = Hugh's correction. Each message is tagged to the screenshot it's
// about via `image_id` (threads are per screenshot, not per note).
export type NoteMessageRole = 'user' | 'assistant';

export interface NoteMessage {
  id:         string;
  note_id:    string;
  image_id:   string | null;
  role:       NoteMessageRole;
  content:    string;
  created_at: string;
}

// ── The nested tree ─────────────────────────────────────────────────────────
// The API returns flat rows; `lib/notes/tree.ts` nests them. Both node kinds
// carry `children` (nested groups) — for a notebook node, `notes` additionally
// holds the roots of that notebook's own page tree. A container populates only
// `children`; a real notebook or page populates only its content.

export interface NoteNode extends Note {
  children: NoteNode[];
  depth:    number;
}

export interface NotebookNode extends Notebook {
  children: NotebookNode[];
  notes:    NoteNode[];
  depth:    number;
}

// One entry in the Bag drawer. A bagged page carries its notebook's title so
// the drawer can say where it will go back to.
export type BaggedItem =
  | { kind: 'notebook'; node: NotebookNode }
  | { kind: 'note';     node: NoteNode; notebook_id: string; notebook_title: string };

// What `buildTree` hands back: the visible tree plus whatever is in the Bag.
// Bagged rows are lifted out of the tree entirely — a bagged group brings its
// whole subtree with it, so the drawer lists one entry, not many.
export interface NotesTree {
  roots:  NotebookNode[];
  bagged: BaggedItem[];
}

// The flat payload the tree endpoint returns.
export interface NotesTreePayload {
  notebooks: Notebook[];
  notes:     Note[];
}
