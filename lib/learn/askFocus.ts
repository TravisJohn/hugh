// Which card Ask opens on when the learner has not picked one.
//
// Since narrow Learn PR D, Ask teaches one card from its syllabus, so it
// always needs a card. With no explicit focus and no remembered one, it
// starts where the learner is: the first card in board order that is not yet
// mastered, or the first card if every one is. Pure, so the page stays thin.

export interface AskCard {
  id:            string;
  title:         string;
  kanban_column: string;
  position:      number;
}

export function defaultAskCard(cards: readonly AskCard[]): AskCard | null {
  const ordered = [...cards].sort((a, b) => a.position - b.position);
  return ordered.find(c => c.kanban_column !== "done") ?? ordered[0] ?? null;
}
