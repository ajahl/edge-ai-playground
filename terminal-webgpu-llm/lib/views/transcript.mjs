export function createTranscript(blessed, screen) {
  return blessed.log({
    parent: screen,
    top: 4,
    left: 0,
    width: "72%",
    height: "100%-8",
    border: "line",
    label: " Transcript ",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    mouse: false,
    keys: true,
    scrollbar: { ch: " ", inverse: true },
    vi: true,
    style: { border: { fg: "cyan" } },
  });
}
