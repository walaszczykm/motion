import { Driver, DriverControls } from "./types"
import { keyframes as keyframeAnimation } from "./keyframes"
import { spring } from "./spring"
import { decay } from "./decay"
import { sync, cancelSync } from "../../frameloop"
import { interpolate } from "../../utils/interpolate"
import { FrameData } from "../../frameloop/types"
import { AnimationOptions } from "../types"

const types = {
    decay,
    keyframes: keyframeAnimation,
    tween: keyframeAnimation,
    spring,
}

export function loopElapsed(elapsed: number, duration: number, delay = 0) {
    return elapsed - duration - delay
}

export function reverseElapsed(
    elapsed: number,
    duration: number = 0,
    delay = 0,
    isForwardPlayback = true
) {
    return isForwardPlayback
        ? loopElapsed(duration + -elapsed, duration, delay)
        : duration - (elapsed - duration) + delay
}

export function hasRepeatDelayElapsed(
    elapsed: number,
    duration: number,
    delay: number,
    isForwardPlayback: boolean
) {
    return isForwardPlayback ? elapsed >= duration + delay : elapsed <= -delay
}

const framesync: Driver = (update) => {
    const passTimestamp = ({ delta }: FrameData) => update(delta)

    return {
        start: () => sync.update(passTimestamp, true),
        stop: () => cancelSync.update(passTimestamp),
    }
}

export function animateValue<V = number>({
    duration,
    driver = framesync,
    elapsed = 0,
    repeat: repeatMax = 0,
    repeatType = "loop",
    repeatDelay = 0,
    keyframes,
    autoplay = true,
    onPlay,
    onStop,
    onComplete,
    onRepeat,
    onUpdate,
    type = "keyframes",
    ...options
}: AnimationOptions<V>) {
    const initialElapsed = elapsed
    let driverControls: DriverControls | undefined
    let repeatCount = 0
    let computedDuration: number | undefined = duration
    let isComplete = false
    let isForwardPlayback = true

    let interpolateFromNumber: (t: number) => V

    const animator =
        types[keyframes.length > 2 ? "keyframes" : type] || keyframeAnimation

    const origin = keyframes[0]
    const target = keyframes[keyframes.length - 1]

    let state = { done: false, value: origin }

    /**
     * If this value needs interpolation (ie is non-numerical), set up an interpolator.
     * TODO: Keyframes animation also performs this step. This could be removed so it only happens here.
     */
    const { needsInterpolation } = animator as any
    if (needsInterpolation && needsInterpolation(origin, target)) {
        interpolateFromNumber = interpolate([0, 100], [origin, target], {
            clamp: false,
        }) as (t: number) => V
        keyframes = [0, 100] as any
    }

    const animation = animator({
        ...options,
        duration,
        keyframes,
    } as any)

    function repeat() {
        repeatCount++

        if (repeatType === "reverse") {
            isForwardPlayback = repeatCount % 2 === 0
            elapsed = reverseElapsed(
                elapsed,
                computedDuration,
                repeatDelay,
                isForwardPlayback
            )
        } else {
            elapsed = loopElapsed(elapsed, computedDuration!, repeatDelay)
            if (repeatType === "mirror") animation.flipTarget()
        }

        isComplete = false
        onRepeat && onRepeat()
    }

    function complete() {
        driverControls && driverControls.stop()
        onComplete && onComplete()
    }

    function update(delta: number) {
        if (!isForwardPlayback) delta = -delta

        elapsed += delta

        if (!isComplete) {
            state = animation.next(Math.max(0, elapsed)) as any

            if (interpolateFromNumber)
                state.value = interpolateFromNumber(state.value as any)

            isComplete = isForwardPlayback ? state.done : elapsed <= 0
        }

        onUpdate && onUpdate(state.value)

        if (isComplete) {
            if (repeatCount === 0) {
                computedDuration =
                    computedDuration !== undefined ? computedDuration : elapsed
            }

            if (repeatCount < repeatMax) {
                hasRepeatDelayElapsed(
                    elapsed,
                    computedDuration!,
                    repeatDelay,
                    isForwardPlayback
                ) && repeat()
            } else {
                complete()
            }
        }
    }

    function play() {
        onPlay && onPlay()
        driverControls = driver(update)
        driverControls.start()
    }

    autoplay && play()

    return {
        stop: () => {
            onStop && onStop()
            driverControls && driverControls.stop()
        },
        /**
         * Set the current time of the animation. This is purposefully
         * mirroring the WAAPI animation API to make them interchanagable.
         * Going forward this file should be ported more towards
         * https://github.com/motiondivision/motionone/blob/main/packages/animation/src/Animation.ts
         * Which behaviourally adheres to WAAPI as far as possible.
         *
         * WARNING: This is not safe to use for most animations. We currently
         * only use it for handoff from WAAPI within Framer.
         *
         * This animation function consumes time every frame rather than being sampled for time.
         * So the sample() method performs some headless frames to ensure
         * repeats are handled correctly. Ideally in the future we will replace
         * that method with this, once repeat calculations are pure.
         */
        set currentTime(t: number) {
            elapsed = initialElapsed
            update(t)
        },
        /**
         * animate() can't yet be sampled for time, instead it
         * consumes time. So to sample it we have to run a low
         * temporal-resolution version.
         *
         * isControlled should be set to true if sample is being run within
         * a loop. This indicates that we're not arbitrarily sampling
         * the animation but running it one step after another. Therefore
         * we don't need to run a low-res version here. This is a stop-gap
         * until a rewrite can sample for time.
         */
        sample: (t: number, isControlled: boolean = false) => {
            elapsed = initialElapsed

            if (isControlled) {
                update(t)
                return state
            }

            const sampleResolution =
                duration && typeof duration === "number"
                    ? Math.max(duration * 0.5, 50)
                    : 50

            let sampleElapsed = 0
            update(0)

            while (sampleElapsed <= t) {
                const remaining = t - sampleElapsed
                update(Math.min(remaining, sampleResolution))
                sampleElapsed += sampleResolution
            }

            return state
        },
    }
}
