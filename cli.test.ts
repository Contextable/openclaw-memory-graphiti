/**
 * CLI module tests — verifies registerCommands() registers all expected
 * subcommands and that the CliContext is wired correctly.
 */

import { describe, test, expect } from "vitest";
import { registerCommands, type CliContext } from "./cli.js";

// ============================================================================
// Mock Commander — captures registered subcommand names and action handlers
// ============================================================================

function createMockProgram() {
  // oxlint-disable-next-line typescript/no-explicit-any
  const actions: Record<string, any> = {};
  const commands: string[] = [];

  // oxlint-disable-next-line typescript/no-explicit-any
  function makeChainable(commandName?: string): any {
    // oxlint-disable-next-line typescript/no-explicit-any
    const self: Record<string, any> = {};
    self.description = () => self;
    self.argument = () => self;
    self.option = () => self;
    self.command = (name: string) => {
      commands.push(name);
      return makeChainable(name);
    };
    // oxlint-disable-next-line typescript/no-explicit-any
    self.action = (fn: any) => {
      if (commandName) actions[commandName] = fn;
      return self;
    };
    return self;
  }

  return { program: makeChainable(), actions, commands };
}

// ============================================================================
// Minimal mock context
// ============================================================================

function createMockContext(): CliContext {
  return {
    graphiti: {} as CliContext["graphiti"],
    spicedb: {} as CliContext["spicedb"],
    cfg: {
      spicedb: { endpoint: "localhost:50051", token: "test", insecure: true },
      graphiti: { endpoint: "http://localhost:8000", defaultGroupId: "main" },
      subjectType: "agent" as const,
      subjectId: "test-agent",
      autoCapture: true,
      autoRecall: true,
      maxCaptureMessages: 10,
      customInstructions: "",
    },
    currentSubject: { type: "agent", id: "test-agent" },
    getLastWriteToken: () => undefined,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("registerCommands", () => {
  test("registers graphiti-mem parent and all 8 subcommands", () => {
    const { program, commands } = createMockProgram();
    const ctx = createMockContext();

    registerCommands(program, ctx);

    // First command is the parent "graphiti-mem", followed by 8 subcommands
    expect(commands[0]).toBe("graphiti-mem");
    const subcommands = commands.slice(1);
    expect(subcommands).toContain("search");
    expect(subcommands).toContain("episodes");
    expect(subcommands).toContain("status");
    expect(subcommands).toContain("schema-write");
    expect(subcommands).toContain("groups");
    expect(subcommands).toContain("add-member");
    expect(subcommands).toContain("cleanup");
    expect(subcommands).toContain("import");
    expect(subcommands).toHaveLength(8);
  });

  test("registers action handlers for all subcommands", () => {
    const { program, actions } = createMockProgram();
    const ctx = createMockContext();

    registerCommands(program, ctx);

    expect(typeof actions["search"]).toBe("function");
    expect(typeof actions["episodes"]).toBe("function");
    expect(typeof actions["status"]).toBe("function");
    expect(typeof actions["schema-write"]).toBe("function");
    expect(typeof actions["groups"]).toBe("function");
    expect(typeof actions["add-member"]).toBe("function");
    expect(typeof actions["cleanup"]).toBe("function");
    expect(typeof actions["import"]).toBe("function");
  });

  test("getLastWriteToken returning undefined is accepted", () => {
    const { program } = createMockProgram();
    const ctx = createMockContext();
    ctx.getLastWriteToken = () => undefined;

    // Should not throw
    registerCommands(program, ctx);
  });
});
