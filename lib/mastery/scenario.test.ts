import { describe, expect, it } from "vitest";
import { randomScenario, SCENARIO_KEYS } from "./scenario";

describe("randomScenario", () => {
  it("can land on every scenario, so no context is ever left out", () => {
    const landed = SCENARIO_KEYS.map((_, i) => randomScenario(() => i / SCENARIO_KEYS.length));
    expect(landed).toEqual([...SCENARIO_KEYS]);
  });

  it("stays on the list at the very top of the random range", () => {
    expect(randomScenario(() => 0.999999)).toBe(SCENARIO_KEYS[SCENARIO_KEYS.length - 1]);
  });
});
