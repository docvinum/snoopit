/**
 * Is this element part of the interface a person actually sees?
 *
 * The goal (spec §13) is *not* to detect and defeat honeypots. It is the opposite:
 * to automatically leave alone the elements that are not part of the normal user
 * interface, because interacting with them is both wrong and a strong signal that
 * the workflow has drifted from what it thinks it is doing.
 *
 * The predicate is pure. Backends gather an `ElementView` — the browser one from
 * `getComputedStyle` and layout boxes, the fake one from a parsed DOM — and the
 * decision itself is shared, so it can be exhaustively tested without a browser.
 */

export interface ElementView {
  /** Border-box width in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Computed `display`, e.g. `block`, `none`. */
  readonly display: string;
  /** Computed `visibility`, e.g. `visible`, `hidden`, `collapse`. */
  readonly visibility: string;
  /** Computed `opacity`, 0..1. */
  readonly opacity: number;
  /** Computed `pointer-events`, e.g. `auto`, `none`. */
  readonly pointerEvents: string;
  /** True when the element or an ancestor carries `aria-hidden="true"`. */
  readonly ariaHidden: boolean;
  /** True when the element or an ancestor is `inert`. */
  readonly inert: boolean;
  /** True when the element or an ancestor carries the `hidden` attribute. */
  readonly hidden: boolean;
  /** True for a disabled form control. */
  readonly disabled: boolean;
  /**
   * True when the element's box intersects the viewport *or* it sits inside a
   * scrollable ancestor that could bring it into view. Content below the fold is
   * ordinary interface, not hidden content.
   */
  readonly reachable: boolean;
}

/** Why an element was rejected. Stable identifiers, safe to assert on and to log. */
export type NotInteractableReason =
  | 'zero-size'
  | 'display-none'
  | 'visibility-hidden'
  | 'fully-transparent'
  | 'pointer-events-none'
  | 'aria-hidden'
  | 'inert'
  | 'hidden-attribute'
  | 'disabled'
  | 'unreachable';

export interface InteractabilityVerdict {
  readonly interactable: boolean;
  /** Every rule that rejected the element, in a stable order. Empty when interactable. */
  readonly reasons: readonly NotInteractableReason[];
}

/**
 * An element smaller than this in either dimension is treated as having no size.
 * A 1x1 pixel is a tracking beacon or a layout artefact, never a control someone
 * clicks; the tolerance above zero also absorbs sub-pixel layout rounding.
 */
const MIN_INTERACTIVE_SIZE_PX = 2;

/** Below this, the element is invisible to a person even though it occupies space. */
const MIN_OPACITY = 0.05;

export function isHumanInteractable(view: ElementView): InteractabilityVerdict {
  const reasons: NotInteractableReason[] = [];

  if (view.display === 'none') reasons.push('display-none');
  if (view.visibility === 'hidden' || view.visibility === 'collapse') {
    reasons.push('visibility-hidden');
  }
  if (view.hidden) reasons.push('hidden-attribute');
  if (view.ariaHidden) reasons.push('aria-hidden');
  if (view.inert) reasons.push('inert');
  if (view.width < MIN_INTERACTIVE_SIZE_PX || view.height < MIN_INTERACTIVE_SIZE_PX) {
    reasons.push('zero-size');
  }
  if (view.opacity < MIN_OPACITY) reasons.push('fully-transparent');
  if (view.pointerEvents === 'none') reasons.push('pointer-events-none');
  if (view.disabled) reasons.push('disabled');
  if (!view.reachable) reasons.push('unreachable');

  return { interactable: reasons.length === 0, reasons };
}

/** A view describing a plainly visible, ordinary element. Handy as a test baseline. */
export const VISIBLE_ELEMENT_VIEW: ElementView = {
  width: 120,
  height: 32,
  display: 'block',
  visibility: 'visible',
  opacity: 1,
  pointerEvents: 'auto',
  ariaHidden: false,
  inert: false,
  hidden: false,
  disabled: false,
  reachable: true,
};
