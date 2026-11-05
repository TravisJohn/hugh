// The contexts a Mastery conversation can be set in. Lives here rather than in
// MasteryClient so the server page can choose one: a choice made during the
// client's first render differs between the server and the browser, and React
// then throws the page away and rebuilds it.

export const SCENARIO_KEYS = ["interview", "client", "huddle", "teaching"] as const;

export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

/** `pick` returns a number in [0, 1), as Math.random does. */
export function randomScenario(pick: () => number = Math.random): ScenarioKey {
  return SCENARIO_KEYS[Math.floor(pick() * SCENARIO_KEYS.length)];
}
