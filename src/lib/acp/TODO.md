# ACP TODO

- [x] Expose the shipped ACP session lifecycle methods in [client.ts](/Users/raunak/Documents/GitHub/Acode/src/lib/acp/client.ts): `loadSession`, `authenticate`, `setSessionMode`, `setSessionModel`, `setSessionConfigOption`, and `unstable_listSessions`.
- [ ] Expose the remaining unstable ACP lifecycle methods in [client.ts](/Users/raunak/Documents/GitHub/Acode/src/lib/acp/client.ts): `unstable_resumeSession` and `unstable_forkSession`.
- [ ] Handle the remaining ACP session update types in [session.ts](/Users/raunak/Documents/GitHub/Acode/src/lib/acp/session.ts): `agent_thought_chunk`, `available_commands_update`, `session_info_update`, and `usage_update`.
- [x] Add ACP authentication flow to the UI in [acp.js](/Users/raunak/Documents/GitHub/Acode/src/pages/acp/acp.js), including `authMethods` handling, auth-required retries, and auth URL fallbacks.
- [ ] Investigate the provider-specific ChatGPT ACP auth hang where `authenticate(methodId: "chatgpt")` does not send any follow-up ACP response or extension traffic.
- [x] Implement client-side ACP `fs/*` handlers and register them from the ACP page.
- [ ] Implement client-side ACP `terminal/*` handlers and register them from the ACP page or a dedicated integration layer.
- [x] Expand the ACP prompt composer beyond text-only prompts to support images, audio, and resource links where supported by agent capabilities.
- [x] Add basic session persistence/resume UI via ACP history and `loadSession`.
- [ ] Surface more ACP metadata in the UI: usage/token stats, session info, and available commands.
- [ ] Consider whether ACP transport should remain WebSocket-only or support additional transport types.
- [ ] Add broader runtime verification against real ACP servers, especially terminal flows and provider-specific auth variants.
