/**
 * useStickyScroll tests.
 *
 * jsdom has no layout, so `scrollHeight`, `scrollTop` and `clientHeight` are
 * supplied by a hand-built element. That is enough: the hook's whole contract
 * is arithmetic over those three numbers plus a `scrollTo` call.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStickyScroll } from './useStickyScroll.ts';

interface FakeScroller {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  scrollTo: ReturnType<typeof vi.fn>;
}

function fakeElement(overrides: Partial<FakeScroller> = {}): FakeScroller {
  return { scrollHeight: 1000, scrollTop: 0, clientHeight: 400, scrollTo: vi.fn(), ...overrides };
}

function setup(element: FakeScroller, dependency = 0) {
  const hook = renderHook(({ dep }) => useStickyScroll<HTMLDivElement>(dep), {
    initialProps: { dep: dependency },
  });
  // The ref is a plain object; attaching the fake here mirrors React
  // assigning the DOM node on mount, before the next effect run.
  hook.result.current.ref.current = element as unknown as HTMLDivElement;
  return hook;
}

describe('useStickyScroll', () => {
  it('starts pinned and follows new content to the bottom', () => {
    const element = fakeElement();
    const hook = setup(element);
    expect(hook.result.current.pinned).toBe(true);

    element.scrollHeight = 1600;
    hook.rerender({ dep: 1 });
    expect(element.scrollTop).toBe(1600);
  });

  it('unpins when the reader scrolls up past the threshold', () => {
    const element = fakeElement({ scrollTop: 100 });
    const hook = setup(element);

    act(() => hook.result.current.handleScroll());
    expect(hook.result.current.pinned).toBe(false);
  });

  it('stays pinned when the reader is within the threshold of the bottom', () => {
    // 1000 - 560 - 400 = 40px from the bottom, inside the 48px allowance.
    const element = fakeElement({ scrollTop: 560 });
    const hook = setup(element);

    act(() => hook.result.current.handleScroll());
    expect(hook.result.current.pinned).toBe(true);
  });

  it('stops following content once unpinned, so a reader is never yanked down', () => {
    const element = fakeElement({ scrollTop: 100 });
    const hook = setup(element);
    act(() => hook.result.current.handleScroll());

    element.scrollHeight = 2000;
    hook.rerender({ dep: 1 });
    expect(element.scrollTop).toBe(100);
  });

  it('scrollToBottom scrolls smoothly and re-pins', () => {
    const element = fakeElement({ scrollTop: 100 });
    const hook = setup(element);
    act(() => hook.result.current.handleScroll());
    expect(hook.result.current.pinned).toBe(false);

    act(() => hook.result.current.scrollToBottom());
    expect(element.scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(hook.result.current.pinned).toBe(true);
  });

  it('tolerates being called before the element is attached', () => {
    const hook = renderHook(() => useStickyScroll<HTMLDivElement>(0));
    expect(() => {
      act(() => {
        hook.result.current.handleScroll();
        hook.result.current.scrollToBottom();
      });
    }).not.toThrow();
    expect(hook.result.current.pinned).toBe(true);
  });
});
