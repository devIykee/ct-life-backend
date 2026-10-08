# Next Session: Complete Remaining Audit Fixes

## Context
You are continuing work on the CT Life backend codebase. The P2 bug fixes (B13-B18, B33-B36) have been completed and pushed to main. Your task is to complete the remaining audit items from the handoff documentation.

## What's Been Done
- **P2 Fixes Complete**: All 9 P2 bugs fixed (B13, B14, B15, B16, B17, B18, B33, B34, B36)
- **Key implementations**:
  - Lottery roll and character creation flow with validation
  - Needs decay system with shift-aware pausing
  - Auth response shapes with hasCharacter
  - Config endpoint improvements (ETag, version checking)
  - Seat rejection matching and sit animations
- **Documentation**: See `P2-COMPLETION-SUMMARY.md` for full details
- **Branch**: All work is on `main` branch and pushed to origin

## Your Task: Complete Remaining Audit Items

You need to work through the remaining issues documented in the handoff. The handoff document is located in the repository and contains a comprehensive list of bugs, their priorities, and expected fixes.

### Step 1: Locate and Review the Handoff Document
1. Search for the handoff document in the repository (likely in docs/, or root)
2. Look for filenames like: `HANDOFF.md`, `AUDIT.md`, `BUGS.md`, `TODO.md`, or similar
3. If you can't find it, search for references to audit items, P1/P2/P3 bugs, or issue tracking
4. Review the ENTIRE document to understand all remaining work

### Step 2: Identify All Remaining Issues
After reviewing the handoff document, create a comprehensive list of:
- **P1 (Critical) issues** - highest priority, must be fixed
- **P3 (Nice-to-have) issues** - lower priority, fix if time permits
- Any other categories mentioned in the handoff

Organize them by:
- Priority level
- Component/area (API, realtime, database, etc.)
- Complexity (simple vs complex fixes)
- Dependencies (some fixes may depend on others)

### Step 3: Work Through Issues Systematically

For each issue:

1. **Understand the Problem**:
   - Read the bug description carefully
   - Identify what's broken and expected behavior
   - Find related code files
   - Check if there are existing tests

2. **Plan the Fix**:
   - Determine the root cause
   - Design the solution
   - Consider edge cases and backward compatibility
   - Estimate scope (single file vs multi-file change)

3. **Implement**:
   - Make focused commits (one issue or related group per commit)
   - Use commit format: `fix: <description> (<issue-id>)`
   - Add comments referencing the issue ID (e.g., `// B42 fix:`)
   - Update relevant documentation inline

4. **Verify**:
   - Run `pnpm typecheck` after each change
   - Run relevant tests if available
   - Test manually if needed (start server, test endpoints)

5. **Commit Pattern**:
   - Work directly on `main` branch
   - Commit frequently (after each logical fix or small group)
   - Push to origin after every 3-5 commits or after completing a priority level
   - Use descriptive commit messages

### Step 4: Handle Complex Issues

For complex or multi-part issues:

1. **Database Migrations**:
   - Create new migration files in `db/migrations/`
   - Use timestamp format: `1700000XXX000_description.sql`
   - Include both UP and DOWN migration
   - Document the change in comments

2. **API Contract Changes**:
   - Check `contract/` directory for API specs
   - Ensure changes match contract expectations
   - Update schemas if needed

3. **Realtime/WebSocket Issues**:
   - Check `server/realtime/rooms/` for room logic
   - Test message handlers and state updates
   - Verify Colyseus schema changes

4. **Cross-Cutting Concerns**:
   - If a fix affects multiple components, break it into logical commits
   - Update all affected areas before committing
   - Document the relationship between changes

### Step 5: Document Your Work

As you complete issues:

1. **Track Progress**:
   - Update or create a progress tracking file
   - Mark issues as complete with commit hash
   - Note any issues that couldn't be fixed and why

2. **Create Summary**:
   - At the end, create a `REMAINING_FIXES_SUMMARY.md` document
   - List all completed fixes with descriptions
   - Note any remaining issues
   - Include testing notes
   - Document any breaking changes or deployment notes

3. **Final Push**:
   - Push all commits to main
   - Ensure summary document is committed
   - Verify all typechecks pass

## Important Guidelines

### Code Quality
- **Match existing patterns**: Read surrounding code and follow the same style
- **Type safety**: Ensure TypeScript types are correct, no `any` types
- **Error handling**: Use existing error classes from `server/shared/domain/errors.ts`
- **Validation**: Use Zod schemas for input validation
- **Comments**: Add comments for non-obvious logic or bug fixes

### Testing
- Run `pnpm typecheck` frequently
- Run `pnpm test:unit` to check for regressions
- If tests fail due to your changes, fix them
- Pre-existing test failures (like space.test.ts) can be ignored

### Database
- Never modify existing migrations
- Always create new migration files for schema changes
- Use transactions for data modifications
- Check `db/migrations/` for migration patterns

### API Changes
- Maintain backward compatibility
- Check contract definitions in `contract/` directory
- Update OpenAPI specs if they exist
- Test with curl or Postman if possible

### Realtime Changes
- Understand Colyseus room lifecycle
- Check message schemas carefully
- Test state synchronization
- Verify client-server message flow

### Performance
- Avoid N+1 queries
- Use database indexes where appropriate
- Cache config data appropriately
- Consider connection pooling

### Security
- Validate all user inputs
- Check authentication/authorization
- Prevent SQL injection (use parameterized queries)
- Don't log sensitive data

## Debugging Tips

If you encounter issues:

1. **TypeScript Errors**:
   - Run `pnpm typecheck` to see all errors
   - Fix types from the bottom up (dependencies first)
   - Check imports and exports

2. **Runtime Errors**:
   - Check logs for stack traces
   - Add console.log/debug statements
   - Verify environment variables are set

3. **Database Issues**:
   - Check migration status
   - Verify connection pool settings
   - Look at query logs
   - Use `EXPLAIN ANALYZE` for slow queries

4. **Integration Issues**:
   - Check related files in the same directory
   - Search for function/type usage across codebase
   - Verify imports are correct

## File Structure Reference

Key directories:
- `server/api/` - REST API routes and middleware
- `server/application/` - Business logic services
- `server/realtime/` - WebSocket/Colyseus rooms
- `server/shared/` - Shared utilities, errors, database
- `db/migrations/` - Database schema migrations
- `contract/` - API contracts and game configs
- `contract/config/` - Game configuration JSON files
- `contract/ids/` - Registry JSON files (items, careers, etc.)

Important files:
- `server/api/main.ts` - API server setup
- `server/application/context.ts` - DI context
- `server/shared/domain/errors.ts` - Error hierarchy
- `server/shared/db/pool.ts` - Database connection
- `server/shared/db/uow.ts` - Transaction helper

## Expected Output

By the end of this session, you should have:

1. ✅ All remaining P1 issues fixed
2. ✅ As many P3 issues fixed as time permits
3. ✅ All changes committed and pushed to main
4. ✅ Comprehensive summary document created
5. ✅ All typechecks passing
6. ✅ No regressions introduced
7. ✅ Clear documentation of any unfinished work

## Success Criteria

- Every fix is well-tested (at minimum, typechecks pass)
- Commit messages are clear and reference issue IDs
- Code follows existing patterns and conventions
- No breaking changes without documentation
- Summary document is complete and accurate
- All work is pushed to origin/main

## Starting Point

1. Pull latest from main (should be at commit `0599c7a` or later)
2. Read the handoff document thoroughly
3. Create a working plan of all issues to fix
4. Start with P1 issues, then move to P3
5. Work systematically, commit frequently, push regularly

## Notes

- The codebase is a TypeScript backend with Fastify (REST) and Colyseus (WebSocket)
- PostgreSQL database with manual migrations
- Redis for caching and sessions
- Solana blockchain integration for Web3 features
- Game server for CT Life (crypto-themed life simulation game)

Good luck! Work through the issues methodically, test thoroughly, and document everything.
