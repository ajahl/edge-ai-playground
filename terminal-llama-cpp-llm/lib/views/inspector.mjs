export function createInspector(blessed, screen) {
  return blessed.box({
    parent: screen,
    top: 4,
    left: "72%",
    width: "28%",
    height: "50%-1",
    border: "line",
    label: " Status ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "yellow" } },
  });
}
