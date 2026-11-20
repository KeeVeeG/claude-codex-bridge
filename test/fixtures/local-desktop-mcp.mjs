import { runMcpServer } from '../../scripts/mcp.mjs';
import { executeBridgeTool } from '../../lib/bridge-service.mjs';

// The caller is testing a rejection from its local Desktop catalog, including on a macOS runner.
// Select only that route policy; preserve the real MCP framing, caller check, sockets and dispatcher.
await runMcpServer({ executor: (name, args, context) => executeBridgeTool(name, args, { ...context, platform: 'win32' }) });
