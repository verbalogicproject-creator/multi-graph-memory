/**
 * The blessed screen. Everything that touches a terminal lives here.
 *
 * Kept apart from `app.ts` so the decisions -- what a pane shows, how a reason
 * is worded, when a verdict is bad -- stay pure and asserted by `npm test`,
 * while this file holds only layout and key bindings, which genuinely need a
 * terminal and are checked by running it.
 */

import type { Widgets } from "blessed";
import { PANES, emptyState, gatherHealth, loadBlessed, renderHealth, wrap, type Pane, type TuiOptions } from "./app.ts";

const TITLES: Record<Pane, string> = {
  health: "Health",
  browse: "Browse",
  ask: "Ask",
  act: "Act",
};

const HELP: Record<Pane, string> = {
  health: "is this system telling the truth",
  browse: "walk the graph, read the evidence",
  ask: "query, and see where the answer came from",
  act: "register, rebuild, approve",
};

export interface RunningTui {
  close(): void;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const { blessed } = await loadBlessed();

  const screen = blessed.screen({
    smartCSR: true,
    title: "multi-memory",
    fullUnicode: true,
    // A phone terminal reports its own size; never assume 80.
    autoPadding: false,
  });

  let pane: Pane = "health";
  let busy = false;

  const tabs = blessed.box({
    top: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { bg: "black" },
  });

  const body = blessed.box({
    top: 1,
    left: 0,
    width: "100%",
    height: "100%-3",
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    vi: true,
    mouse: true,
    padding: { left: 1, right: 1 },
    scrollbar: { ch: " ", style: { bg: "grey" } },
  });

  const input = blessed.textbox({
    bottom: 1,
    left: 0,
    width: "100%",
    height: 1,
    inputOnFocus: true,
    hidden: true,
    style: { bg: "black", fg: "white" },
  });

  const status = blessed.box({
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    style: { bg: "black" },
  });

  screen.append(tabs);
  screen.append(body);
  screen.append(input);
  screen.append(status);

  const width = (): number => Number(screen.width) || 45;

  function drawTabs(): void {
    tabs.setContent(
      PANES.map((name, index) =>
        name === pane
          ? `{black-fg}{white-bg} ${index + 1} ${TITLES[name]} {/}`
          : `{grey-fg} ${index + 1} ${TITLES[name]} {/}`,
      ).join(""),
    );
  }

  function setStatus(text: string, colour = "grey"): void {
    status.setContent(`{${colour}-fg}${text}{/}`);
    screen.render();
  }

  async function draw(): Promise<void> {
    drawTabs();
    setStatus(`${HELP[pane]}  ·  1-4 switch · r refresh · q quit`);
    if (pane === "health") {
      const rows = gatherHealth(options);
      body.setContent(renderHealth(rows, width()));
      const worst = rows.some((r) => r.verdict === "bad")
        ? "red"
        : rows.some((r) => r.verdict === "warn")
          ? "yellow"
          : "green";
      setStatus(`${HELP[pane]}  ·  1-4 switch · r refresh · q quit`, worst);
    } else if (pane === "browse") {
      body.setContent(await runAndFormat("lesson list", "browse"));
    } else if (pane === "act") {
      body.setContent(
        [
          "{bold}Actions{/bold}",
          "",
          "  a  approve a lesson   (human only, and only here)",
          "  v  revoke a lesson",
          "  d  doctor",
          "",
          ...wrap(
            "Approval is deliberately absent from every model-facing surface: it is not exposed over MCP " +
              "and no model can reach it. That is why this pane exists rather than a tool call.",
            Math.max(20, width() - 2),
          ).map((line) => `{grey-fg}${line}{/}`),
        ].join("\n"),
      );
    } else {
      body.setContent(
        [
          "{bold}Ask{/bold}",
          "",
          ...wrap("Press / to type a question. The answer names the signal behind it, and says why when nothing matched.", Math.max(20, width() - 2)).map(
            (line) => `{grey-fg}${line}{/}`,
          ),
        ].join("\n"),
      );
    }
    screen.render();
  }

  /** Run one command through the shared path and render whatever it says. */
  async function runAndFormat(line: string, forPane: Pane): Promise<string> {
    if (busy) return "…";
    busy = true;
    setStatus(`running: ${line}`, "yellow");
    try {
      const output = await options.runCommand(line);
      const text = output.trim();
      // The whole reason this surface exists: an empty answer is still an
      // answer, and it has to say which kind of empty it is.
      if (!text) {
        return emptyState(
          forPane,
          `\`${line}\` returned nothing at all — not an empty result, but no output. That is a bug in the command, not an absence of data.`,
        );
      }
      return text;
    } catch (error) {
      return `{red-fg}refused{/}\n\n${wrap(error instanceof Error ? error.message : String(error), Math.max(20, width() - 2)).join("\n")}`;
    } finally {
      busy = false;
      setStatus(`${HELP[forPane]}  ·  1-4 switch · r refresh · q quit`);
    }
  }

  function prompt(label: string, then: (value: string) => Promise<void>): void {
    input.show();
    input.setValue("");
    setStatus(label, "cyan");
    input.focus();
    input.once("submit", (value: string) => {
      input.hide();
      body.focus();
      void then(String(value ?? "").trim());
    });
    input.once("cancel", () => {
      input.hide();
      body.focus();
      screen.render();
    });
    screen.render();
  }

  screen.key(["1", "2", "3", "4"], (ch: string) => {
    pane = PANES[Number(ch) - 1] ?? pane;
    void draw();
  });
  screen.key(["left", "S-tab"], () => {
    pane = PANES[(PANES.indexOf(pane) + PANES.length - 1) % PANES.length]!;
    void draw();
  });
  screen.key(["right", "tab"], () => {
    pane = PANES[(PANES.indexOf(pane) + 1) % PANES.length]!;
    void draw();
  });
  screen.key(["r"], () => void draw());
  screen.key(["/"], () => {
    pane = "ask";
    drawTabs();
    prompt("question: ", async (question) => {
      if (!question) return;
      body.setContent(await runAndFormat(`ask ${question}`, "ask"));
      screen.render();
    });
  });
  screen.key(["a"], () => {
    if (pane !== "act") return;
    prompt("lesson id to approve: ", async (id) => {
      if (!id) return;
      prompt("approver name: ", async (by) => {
        if (!by) return;
        body.setContent(await runAndFormat(`lesson approve ${id} --by ${by}`, "act"));
        screen.render();
      });
    });
  });
  screen.key(["d"], () => {
    if (pane !== "act") return;
    void (async () => {
      body.setContent(await runAndFormat("doctor", "act"));
      screen.render();
    })();
  });
  screen.key(["q", "C-c", "escape"], () => {
    screen.destroy();
  });

  body.focus();
  await draw();

  await new Promise<void>((resolveClosed) => {
    (screen as Widgets.Screen & { on(event: string, fn: () => void): void }).on("destroy", () =>
      resolveClosed(),
    );
  });
}
