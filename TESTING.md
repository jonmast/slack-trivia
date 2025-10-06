# Testing Setup

This project now includes comprehensive tests using Vitest.

## Running Tests

```bash
# Run tests in watch mode (default)
pnpm test

# Run tests once and exit
pnpm test:run
```

## Test Structure

- `test/trivia-core.test.ts` - Tests for core trivia game logic
- `test/utils.test.ts` - Tests for utility functions 
- `test/slack-integration.test.ts` - Tests for Slack-specific rendering functions

## Test Coverage

The tests cover:

✅ **Utility Functions**
- `parseTs()` - Slack timestamp parsing
- `withId()` - Answer object creation with UUIDs

✅ **TriviaStore Class** 
- Question fetching and caching
- Error handling for API failures
- Cache management

✅ **Question Logic**
- Question creation and answer shuffling
- Correct answer validation
- Timeout and expiration logic

✅ **Slack Integration**
- HomeView rendering structures
- Block kit formatting

## Test Features

- **Mocking**: External dependencies (fetch, Slack SDK) are mocked
- **Async Testing**: Handles async operations properly  
- **Error Cases**: Tests both success and failure scenarios
- **Edge Cases**: Covers boundary conditions and edge cases

All tests use Vitest with TypeScript support and are configured to run in a Node.js environment.