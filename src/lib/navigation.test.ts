import { describe, expect, it } from "vitest";
import { pageTurnForKey, pageTurnForSwipe } from "./navigation";

describe("reader navigation direction", () => {
  it("maps directional keys for left-to-right and right-to-left books", () => {
    expect(pageTurnForKey("ArrowRight", false)).toBe("forward");
    expect(pageTurnForKey("ArrowLeft", false)).toBe("backward");
    expect(pageTurnForKey("ArrowRight", true)).toBe("backward");
    expect(pageTurnForKey("ArrowLeft", true)).toBe("forward");
    expect(pageTurnForKey("PageDown", true)).toBe("forward");
    expect(pageTurnForKey("PageUp", false)).toBe("backward");
  });

  it("maps deliberate horizontal swipes and ignores short or vertical gestures", () => {
    expect(pageTurnForSwipe(-90, 10, false)).toBe("forward");
    expect(pageTurnForSwipe(90, 10, false)).toBe("backward");
    expect(pageTurnForSwipe(90, 10, true)).toBe("forward");
    expect(pageTurnForSwipe(-90, 10, true)).toBe("backward");
    expect(pageTurnForSwipe(40, 0, false)).toBeUndefined();
    expect(pageTurnForSwipe(80, 70, false)).toBeUndefined();
  });
});
