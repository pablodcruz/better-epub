export type PageTurn = "forward" | "backward";

export function pageTurnForKey(key: string, rightToLeft: boolean): PageTurn | undefined {
  if (key === "PageDown" || key === " ") return "forward";
  if (key === "PageUp") return "backward";
  if (key === "ArrowRight") return rightToLeft ? "backward" : "forward";
  if (key === "ArrowLeft") return rightToLeft ? "forward" : "backward";
  return undefined;
}

export function pageTurnForSwipe(dx: number, dy: number, rightToLeft: boolean): PageTurn | undefined {
  if (Math.abs(dx) <= 60 || Math.abs(dx) <= Math.abs(dy) * 1.4) return undefined;
  const swipedTowardNextPage = rightToLeft ? dx > 0 : dx < 0;
  return swipedTowardNextPage ? "forward" : "backward";
}
