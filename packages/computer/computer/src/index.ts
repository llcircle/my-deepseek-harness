/**
 * The computer-use Service Definition (`ctx.computer`): abstracts "look at the
 * screen, move the pointer, type" into a replaceable seam.
 *
 * Why a seam rather than a toolkit that shells out directly: desktop operation
 * is inherently bound to the execution world (a host desktop, a remote desktop,
 * and an in-container virtual display all differ), and swapping the Provider
 * leaves the tools and prompts above it untouched. This package carries no
 * implementation and does no platform detection.
 *
 * @module @deepseek-ai/dsh-computer
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ComputerAvailability,
  ComputerCallOptions,
  ComputerClickInput,
  ComputerDisplay,
  ComputerDragInput,
  ComputerDragResult,
  ComputerKeyInput,
  ComputerPoint,
  ComputerScreenshot,
  ComputerScrollInput,
  ComputerTypeInput,
} from './types.ts'

export {
  ComputerError,
} from './types.ts'
export type {
  ComputerAvailability,
  ComputerCallOptions,
  ComputerClickInput,
  ComputerDisplay,
  ComputerDragInput,
  ComputerDragResult,
  ComputerErrorCode,
  ComputerKeyInput,
  ComputerMouseButton,
  ComputerPoint,
  ComputerScreenshot,
  ComputerScrollInput,
  ComputerTypeInput,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    computer: ComputerUse
  }
}

/**
 * The computer-use capability. Implementations own platform details, external
 * process lifetimes, and error classification; callers depend only on these
 * semantics.
 *
 * Contract:
 * - Every coordinate lives in one coordinate system: the physical pixels of the
 *   virtual screen {@link ComputerDisplay} describes. Capture and input must
 *   share it, or a click lands somewhere other than where it was aimed.
 * - Every method accepts a cancellation signal; on abort it must terminate the
 *   processes it started and settle promptly.
 * - Expected failures throw a `ComputerError` carrying a stable code rather
 *   than the raw platform error.
 */
export abstract class ComputerUse extends Service {
  constructor(ctx: Context) {
    super(ctx, 'computer')
  }

  /** Provider identity, for diagnostics and prompt narration. */
  abstract readonly provider: string

  /**
   * Probe whether desktop actions can actually execute right now.
   *
   * This is the only method allowed not to throw: when unavailable it returns
   * `available: false` with a reason, so a Consumer can load as usual and merely
   * hide its tools. Implementations should cache the probe result rather than
   * paying a process start on every call.
   *
   * @param options - optional cancellation signal and call metadata.
   * @returns the availability verdict; when unavailable, with a human-readable reason.
   */
  abstract available(options?: ComputerCallOptions): Promise<ComputerAvailability>

  /**
   * Read the virtual screen geometry.
   * @param options - optional cancellation signal and call metadata.
   * @returns the virtual screen's width and height, plus scaling notes when any.
   */
  abstract display(options?: ComputerCallOptions): Promise<ComputerDisplay>

  /**
   * Capture the whole virtual screen.
   * @param options - optional cancellation signal and call metadata.
   * @returns the screenshot attachment and its actual pixel dimensions.
   */
  abstract screenshot(options?: ComputerCallOptions): Promise<ComputerScreenshot>

  /**
   * Read the pointer's current position.
   * @param options - optional cancellation signal and call metadata.
   * @returns the screen coordinates the pointer currently occupies.
   */
  abstract pointer(options?: ComputerCallOptions): Promise<ComputerPoint>

  /**
   * Move the pointer to a position.
   * @param point - the target screen coordinates.
   * @param options - optional cancellation signal and call metadata.
   * @returns the pointer's actual coordinates after the move.
   */
  abstract move(point: ComputerPoint, options?: ComputerCallOptions): Promise<ComputerPoint>

  /**
   * Click at a position, or at the current position when omitted.
   * @param input - click position, button, and count.
   * @param options - optional cancellation signal and call metadata.
   * @returns where the click landed, with the button and count that took effect.
   */
  abstract click(input: ComputerClickInput, options?: ComputerCallOptions): Promise<ComputerPoint & { button: string; clicks: number }>

  /**
   * Drag from an origin to a destination.
   * @param input - origin, destination, and button.
   * @param options - optional cancellation signal and call metadata.
   * @returns the start and end coordinates with the button that took effect.
   */
  abstract drag(input: ComputerDragInput, options?: ComputerCallOptions): Promise<ComputerDragResult>

  /**
   * Type a run of text.
   * @param input - the text to type.
   * @param options - optional cancellation signal and call metadata.
   * @returns how many characters were actually delivered.
   */
  abstract typeText(input: ComputerTypeInput, options?: ComputerCallOptions): Promise<{ characters: number }>

  /**
   * Press and release one chord of keys.
   * @param input - the key sequence, such as `['ctrl', 'c']`.
   * @param options - optional cancellation signal and call metadata.
   * @returns the key sequence actually pressed.
   */
  abstract key(input: ComputerKeyInput, options?: ComputerCallOptions): Promise<{ keys: string[] }>

  /**
   * Scroll at a position, or at the current position when omitted.
   * @param input - scroll position and vertical/horizontal deltas; a positive vertical delta scrolls down, matching DOM `WheelEvent`.
   * @param options - optional cancellation signal and call metadata.
   * @returns where the scroll landed with the deltas that took effect.
   */
  abstract scroll(input: ComputerScrollInput, options?: ComputerCallOptions): Promise<ComputerPoint & { deltaX: number; deltaY: number }>
}

export default ComputerUse
