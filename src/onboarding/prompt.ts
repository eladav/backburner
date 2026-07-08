import * as readline from "node:readline/promises";
import type { Prompter } from "./types.js";

/**
 * Interactive prompter backed by Node.js readline/promises.
 * Writes prompts to stdout; reads from stdin.
 */
export class NodeReadlinePrompter implements Prompter {
  private readonly rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
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
    process.stdout.write(`${lines.join("\n")}\n`);

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

      process.stdout.write(`  Please enter a number between 1 and ${options.length}\n`);
    }
  }

  async multiSelect(
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
    process.stdout.write(`${lines.join("\n")}\n`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = (await this.rl.question("Selection: ")).trim().toLowerCase();

      if (answer === "all") return options.map((_, i) => i);
      if (answer === "" || answer === "none") return preSelected ?? [];

      const parts = answer.split(",").map((p) => p.trim());
      const indices: number[] = [];
      let valid = true;

      for (const part of parts) {
        const n = Number(part);
        if (!Number.isInteger(n) || n < 1 || n > options.length) {
          process.stdout.write(
            `  Invalid selection "${part}". Enter numbers between 1 and ${options.length}\n`
          );
          valid = false;
          break;
        }
        indices.push(n - 1);
      }

      if (valid) return [...new Set(indices)];
    }
  }
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
