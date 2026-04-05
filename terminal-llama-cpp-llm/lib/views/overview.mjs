export function createOverview(blessed, screen) {
  return blessed.box({
    parent: screen,
    top: 1,
    left: 0,
    width: "100%",
    height: 3,
    border: "line",
    label: " Overview ",
    tags: true,
    style: { border: { fg: "green" } },
  });
}
