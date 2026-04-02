---
title: "What's New in Kilo Code"
description: "The Kilo Code extension has been rebuilt from the ground up on the Kilo CLI — faster, more flexible, and with access to 500+ models."
---

# What's New in Kilo Code

The Kilo Code extension has been completely rebuilt on the [Kilo CLI](https://blog.kilo.ai/p/kilo-cli) — a powerful, open-source foundation designed for agentic engineering anywhere you code. This is the biggest update we've ever shipped: a faster, more capable extension with access to 500+ models, seamless terminal-to-IDE workflows, and the flexibility to use the right model for every task.

Whether you're writing features in VS Code, debugging over SSH, or reviewing code on Slack, Kilo now goes with you. Read the [full announcement on the Kilo Blog](https://blog.kilo.ai/p/kilo-cli) for the complete story behind the rebuild.

---

## Adjusting to the new version

A lot has changed under the hood, and some things have moved around. If you're coming from the previous extension, you might have questions about where to find certain features or how things work now. We've collected the most common ones below.

### Where did code indexing go?

Code indexing is temporarily unavailable in the new extension. It is actively being worked on and is expected to return soon.

### How do checkpoints work in the new extension?

Checkpoints are available in the new extension. You can use them to save and restore your workspace state during a task. See the [Checkpoints documentation](/docs/code-with-ai/features/checkpoints) for details on how to use them.

### Where is the auto-confirm commands settings UI?

The auto-confirm commands settings have moved to the new settings panel. The UI has changed, but the functionality is the same. Open the settings panel to configure which commands are auto-approved. See [Auto-Approving Actions](/docs/getting-started/settings/auto-approving-actions) for more information.

### Where did the file reading settings go?

File reading settings are available in the new settings panel. Open settings to configure file reading behavior.

### Where is the UI for configuring local LLM providers?

Local LLM providers can be configured through the new settings panel. See the [Local Models](/docs/automate/extending/local-models) documentation for setup instructions.

### The model selection feels bloated. Can I simplify it?

Model selection has been streamlined in the new extension. You can configure your preferred models to reduce clutter. See [Model Selection](/docs/code-with-ai/agents/model-selection) for details on how to customize which models appear in the selector.

### Is the context progress graph still available?

The context progress graph is being evaluated for the new extension. This feature may be reintroduced in a future update.

### Where are the copy buttons in chat?

Copy functionality is available in the chat interface. Hover over a message or code block to reveal the copy button.

### Where did the in-chat UI for skills, commands, and MCPs go?

MCP configuration has been migrated to the new settings panel. If you had MCPs configured in the old extension, they are automatically migrated to the new version. You can manage MCP servers, skills, and commands through the settings panel. See [MCP Overview](/docs/automate/mcp/overview) for more information.

### Where is the diff view for file changes?

The diff view is still available when reviewing file changes. When the agent proposes changes to a file, you can review the diff before approving.

### How do I do code reviews in the new extension?

Code reviews follow the CLI workflow in the new extension. See the [CLI documentation](/docs/code-with-ai/platforms/cli) for current instructions. Documentation specific to code reviews in the VS Code extension is being updated.

### Settings include Linux commands that don't exist on Windows

This is a known issue. The default command allowlist currently shows bash/Linux commands regardless of your platform. A fix is being worked on to make the default commands platform-dependent. In the meantime, you can manually edit the command allowlist in your settings to match your operating system.
