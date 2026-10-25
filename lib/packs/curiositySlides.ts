// ── The carousel beside the course picker ───────────────────────────────────
// Each slide is one idea, and it opens one course. A slide shows only while its
// course can be started, so the carousel never offers a subject Hugh doesn't
// teach (PRD-narrow-learn.md, row 1). Two slides have no course yet: they stay
// here, hidden, and return when a course for them joins the catalog and the
// slide is given its `packId`.
//
// Pure data; the artwork for each `graphic` lives in the carousel component.

export type SlideGraphic =
  | "clustering" | "maze" | "outlier" | "descent" | "forecast"
  | "experiment" | "network" | "bayesian" | "tree";

export interface CuriositySlide {
  /** The course this slide opens, or null while there is none. */
  packId:      string | null;
  topic:       string;
  category:    string;
  title:       string;
  description: string;
  graphic:     SlideGraphic;
}

export const CURIOSITY_SLIDES: readonly CuriositySlide[] = [
  {
    packId: "clustering",
    topic: "Clustering",
    category: "Machine learning",
    title: "Why do some points belong together?",
    description: "Watch a loose field of observations find its own groups. What counts as similar changes the picture.",
    graphic: "clustering",
  },
  {
    packId: null,
    topic: "Reinforcement learning",
    category: "Machine learning",
    title: "Can a robot learn from a wrong turn?",
    description: "A missed reward sends it back through the maze. Each attempt changes the route it takes next.",
    graphic: "maze",
  },
  {
    packId: "outlier-detection",
    topic: "Outlier detection",
    category: "Statistics · machine learning",
    title: "Which observation doesn’t fit?",
    description: "Most points share a pattern. One sits apart, waiting for someone to ask why.",
    graphic: "outlier",
  },
  {
    packId: null,
    topic: "Gradient descent",
    category: "Machine learning · optimization",
    title: "How does a model find a better answer?",
    description: "Follow each careful step downhill as the model reduces its error.",
    graphic: "descent",
  },
  {
    packId: "time-series-forecasting",
    topic: "Time series forecasting",
    category: "Data science · forecasting",
    title: "How far can a trend see?",
    description: "Past observations point forward, while the range of possible futures widens.",
    graphic: "forecast",
  },
  {
    packId: "ab-testing",
    topic: "A/B testing",
    category: "Statistics · experiments",
    title: "Is B really better, or just lucky?",
    description: "Watch the evidence accumulate before deciding whether a difference is real.",
    graphic: "experiment",
  },
  {
    packId: "neural-networks",
    topic: "Neural networks",
    category: "Machine learning · neural networks",
    title: "How can layers recognize a pattern?",
    description: "Signals combine through a network until a useful pattern reaches the output.",
    graphic: "network",
  },
  {
    packId: "bayesian-inference",
    topic: "Bayesian inference",
    category: "Statistics · probability",
    title: "How should evidence change a belief?",
    description: "A starting belief shifts as new evidence arrives, while uncertainty remains visible.",
    graphic: "bayesian",
  },
  {
    packId: "decision-trees",
    topic: "Decision trees",
    category: "Machine learning · decisions",
    title: "Which question should a model ask first?",
    description: "Each answer splits the possibilities, guiding the model toward a decision.",
    graphic: "tree",
  },
];

export type CourseSlide = CuriositySlide & { packId: string };

/** The slides whose course can be started, in carousel order. */
export function visibleSlides(startable: readonly string[]): CourseSlide[] {
  return CURIOSITY_SLIDES.filter((s): s is CourseSlide => s.packId !== null && startable.includes(s.packId));
}
