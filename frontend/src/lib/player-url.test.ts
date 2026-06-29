import { describe, it, expect } from 'vitest';
import { playerHref, PLAYER_VIEW_SEGMENT } from './player-url';

describe('playerHref', () => {
  it('builds a basic href', () => {
    expect(playerHref('abc')).toBe(`/players/${PLAYER_VIEW_SEGMENT}?id=abc`);
  });

  it('encodes a space', () => {
    expect(playerHref('John Smith')).toBe(
      `/players/${PLAYER_VIEW_SEGMENT}?id=John%20Smith`
    );
  });

  it('encodes an ampersand', () => {
    expect(playerHref('a&b')).toBe(
      `/players/${PLAYER_VIEW_SEGMENT}?id=a%26b`
    );
  });

  it('encodes unicode', () => {
    expect(playerHref('café')).toBe(
      `/players/${PLAYER_VIEW_SEGMENT}?id=caf%C3%A9`
    );
  });

  it('encodes a slash', () => {
    expect(playerHref('a/b')).toBe(
      `/players/${PLAYER_VIEW_SEGMENT}?id=a%2Fb`
    );
  });

  it('round-trips a UUID-style id unchanged (no special chars)', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const href = playerHref(uuid);
    // UUIDs contain only [0-9a-f-], none of which are encoded
    expect(href).toBe(`/players/${PLAYER_VIEW_SEGMENT}?id=${uuid}`);
  });

  it('PLAYER_VIEW_SEGMENT is the literal "view"', () => {
    // The route must match the physical players/view/ folder.
    expect(PLAYER_VIEW_SEGMENT).toBe('view');
  });
});
