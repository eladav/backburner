import { emitKeypressEvents } from "node:readline";
import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { Prompter } from "./types.js";

interface PromptInput extends Readable {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

interface PromptOutput extends Writable {
  isTTY?: boolean;
}

export interface NodeReadlinePrompterOptions {
  input?: PromptInput;
  output?: PromptOutput;
}

/**
 * Interactive prompter backed by Node.js readline/promises.
 * Writes prompts to stdout; reads from stdin.
 */
export class NodeReadlinePrompter implements Prompter {
  private readonly rl: readline.Interface;
  private readonly input: PromptInput;
  private readonly output: PromptOutput;

  constructor(options: NodeReadlinePrompterOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.rl = readline.createInterface({
      input: this.input,
      output: this.output
    });
  }

  close(): void {
    this.rl.close();
  }

  async ask(question: string, defaultValue?: string): Promise<string> {
    const hint = defaultValue !== undefined ? ` [${defaultValue}]` : "";
    const answer = (await this.rl.question(`${question}${hint} `)).trim();
    return answer.length > 0 ? answer : (defaultValue ?? "");
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    const hint =
      defaultValue === true ? "[Y/n]" : defaultValue === false ? "[y/N]" : "[y/n]";
    const answer = (await this.rl.question(`${question} ${hint} `)).trim().toLowerCase();
    if (answer.length === 0) return defaultValue ?? false;
    return answer === "y" || answer === "yes";
  }

  async choose(question: string, options: string[], defaultIndex?: number): Promise<number> {
    const lines: string[] = [question];
    for (let i = 0; i < options.length; i++) {
      const marker = i === defaultIndex ? "*" : " ";
      lines.push(`  ${marker} ${i + 1}. ${options[i] ?? ""}`);
    }
    this.output.write(`${lines.join("\n")}\n`);

    const defaultHint = defaultIndex !== undefined ? ` [${defaultIndex + 1}]` : "";

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = (await this.rl.question(`Enter number${defaultHint}: `)).trim();

      if (answer.length === 0 && defaultIndex !== undefined) {
        return defaultIndex;
      }

      const n = Number(answer);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        return n - 1;
      }

      this.output.write(`  Please enter a number between 1 and ${options.length}\n`);
    }
  }

  async multiSelect(
    question: string,
    options: string[],
    preSelected?: number[]
  ): Promise<number[]> {
    if (canUseTerminalPicker(this.input, this.output)) {
      return this.terminalMultiSelect(question, options, preSelected);
    }

    return this.textMultiSelect(question, options, preSelected);
  }

  private async textMultiSelect(
    question: string,
    options: string[],
    preSelected?: number[]
  ): Promise<number[]> {
    const preSet = new Set(preSelected ?? []);
    const lines: string[] = [
      question,
      "(Enter comma-separated numbers, 'all' to select all, or leave empty for none)"
    ];

    for (let i = 0; i < options.length; i++) {
      const marker = preSet.has(i) ? "[x]" : "[ ]";
      lines.push(`  ${marker} ${i + 1}. ${options[i] ?? ""}`);
    }
    this.output.write(`${lines.join("\n")}\n`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = (await this.rl.question("Selection: ")).trim().toLowerCase();

      const parsed = parseTextMultiSelectAnswer(answer, options.length, preSelected);
      if (parsed.ok) return parsed.indices;

      if (parsed.invalidPart !== undefined) {
        this.output.write(
          `  Invalid selection "${parsed.invalidPart}". Enter numbers between 1 and ${options.length}\n`
        );
      }
    }
  }

  private async terminalMultiSelect(
    question: string,
    options: string[],
    preSelected?: number[]
  ): Promise<number[]> {
    const selected = new Set(preSelected ?? []);
    let cursor = preSelected?.[0] ?? 0;
    if (cursor < 0 || cursor >= options.length) cursor = 0;

    this.rl.pause();
    emitKeypressEvents(this.input);
    this.input.setRawMode?.(true);
    this.input.resume();

    return await new Promise<number[]>((resolve) => {
      const render = (): void => {
        const lines = [
          question,
          "Use ↑/↓ to move, space to toggle, enter to confirm.",
          ...options.map((option, i) => {
            const pointer = i === cursor ? ">" : " ";
            const marker = selected.has(i) ? "[x]" : "[ ]";
            return `${pointer} ${marker} ${option}`;
          })
        ];
        this.output.write(`\x1b[?25l\x1b[2K\r${lines.join("\n")}`);
        this.output.write(`\x1b[${lines.length - 1}A`);
      };

      const finish = (): void => {
        this.input.off("keypress", onKeypress);
        this.input.setRawMode?.(false);
        this.output.write(`\x1b[?25h\x1b[${options.length + 1}B\n`);
        this.rl.resume();
        resolve([...selected].sort((a, b) => a - b));
      };

      const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl === true && key.name === "c") {
          finish();
          return;
        }

        switch (key.name) {
          case "up":
            cursor = cursor <= 0 ? options.length - 1 : cursor - 1;
            render();
            break;
          case "down":
            cursor = cursor >= options.length - 1 ? 0 : cursor + 1;
            render();
            break;
          case "space":
            if (selected.has(cursor)) {
              selected.delete(cursor);
            } else {
              selected.add(cursor);
            }
            render();
            break;
          case "return":
          case "enter":
            finish();
            break;
        }
      };

      this.input.on("keypress", onKeypress);
      render();
    });
  }
}

function canUseTerminalPicker(input: PromptInput, output: PromptOutput): boolean {
  return input.isTTY === true && output.isTTY === true && typeof input.setRawMode === "function";
}

export function parseTextMultiSelectAnswer(
  answer: string,
  optionCount: number,
  preSelected?: number[]
): { ok: true; indices: number[] } | { ok: false; invalidPart?: string } {
  if (answer === "all") return { ok: true, indices: Array.from({ length: optionCount }, (_, i) => i) };
  if (answer === "" || answer === "none") return { ok: true, indices: preSelected ?? [] };

  const parts = answer.split(",").map((p) => p.trim());
  const indices: number[] = [];

  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > optionCount) {
      return { ok: false, invalidPart: part };
    }
    indices.push(n - 1);
  }

  return { ok: true, indices: [...new Set(indices)] };
}

/**
 * Non-interactive prompter that accepts all defaults.
 * Used when --yes is passed or in tests.
 */
export class NonInteractivePrompter implements Prompter {
  ask(_question: string, defaultValue?: string): Promise<string> {
    return Promise.resolve(defaultValue ?? "");
  }

  confirm(_question: string, defaultValue?: boolean): Promise<boolean> {
    return Promise.resolve(defaultValue ?? true);
  }

  choose(_question: string, _options: string[], defaultIndex?: number): Promise<number> {
    return Promise.resolve(defaultIndex ?? 0);
  }

  multiSelect(
    _question: string,
    options: string[],
    preSelected?: number[]
  ): Promise<number[]> {
    return Promise.resolve(preSelected ?? options.map((_, i) => i));
  }
}
