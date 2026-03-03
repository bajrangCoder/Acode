# ACP TODO

- [ ] Expose more ACP session lifecycle methods in [client.ts](/Users/raunak/Documents/GitHub/Acode/src/lib/acp/client.ts): `loadSession`, `authenticate`, `setSessionMode`, `setSessionConfigOption`, `unstable_resumeSession`, `unstable_listSessions`, and `unstable_forkSession`.
- [ ] Handle the remaining ACP session update types in [session.ts](/Users/raunak/Documents/GitHub/Acode/src/lib/acp/session.ts): `agent_thought_chunk`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, and `usage_update`.
- [ ] Add ACP authentication flow to the UI in [acp.js](/Users/raunak/Documents/GitHub/Acode/src/pages/acp/acp.js), including `authMethods` handling and auth-required error flow.
- [ ] Implement client-side ACP `fs/*` handlers and register them from the ACP page or a dedicated integration layer.
- [ ] Implement client-side ACP `terminal/*` handlers and register them from the ACP page or a dedicated integration layer.
- [ ] Expand the ACP prompt composer beyond text-only prompts to support images, audio, embedded resources, and resource links where supported by agent capabilities.
- [ ] Add session persistence/resume UI so the ACP page is not limited to `session/new` on every connect.
- [ ] Surface more ACP metadata in the UI: current mode, config options, usage/token stats, session info, and available commands.
- [ ] Consider whether ACP transport should remain WebSocket-only or support additional transport types.
- [ ] Add runtime verification against a real ACP server, not just TypeScript validation.
