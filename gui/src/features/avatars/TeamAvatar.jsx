import React, {useLayoutEffect, useRef, useState} from "react";
import manifest from "../../assets/team-avatars/manifest.json";
import styles from "./TeamAvatar.module.css";

const assetPrefix = "../../assets/team-avatars/";
const urls = import.meta.glob("../../assets/team-avatars/assets/*/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});
const avatars = new Map(manifest.map(entry => [entry.id, {
  ...entry,
  foreground: urls[assetPrefix + entry.foreground],
  motionAtlas: urls[assetPrefix + entry.motionAtlas],
  chat: urls[assetPrefix + entry.chat],
}]));

export const defaultTeamAvatarId = "barbidou";

export function teamAvatarFor(workspace) {
  return workspace ? avatars.get(workspace.avatarId) ?? avatars.get(defaultTeamAvatarId) : null;
}

export function TeamAvatarPicker({value, onChange, disabled}) {
  return <fieldset className={styles.picker} disabled={disabled}>
    <legend>Team 头像</legend>
    <div className={styles.choices}>
      {Array.from(avatars.values(), avatar =>
        <label key={avatar.id} className={styles.choice}>
          <input type="radio" name="team-avatar" value={avatar.id} checked={value === avatar.id}
            onChange={() => onChange(avatar.id)} />
          <ChatTeamAvatar avatar={avatar} />
          <span>{avatar.name}</span>
        </label>)}
    </div>
  </fieldset>;
}

const imageLoads = new Map();

function loadImage(view, url) {
  if (!url) return Promise.resolve(null);
  if (!imageLoads.has(url)) {
    const image = new view.Image();
    image.src = url;
    imageLoads.set(url, image.decode().then(() => image, () => null));
  }
  return imageLoads.get(url);
}

const frameSize = 256;
const plateInset = 64;
const plateSize = 128;
const plateFloor = plateInset + plateSize;

function poseClip(Path, plate, outlets) {
  const clip = new Path(plate);
  for (const [left, top, width, height, turnX] of outlets) {
    if (turnX === undefined) {
      clip.rect(left, top, width, height);
      continue;
    }
    const right = left + width;
    const bottom = top + height;
    // The clockwise outlet joins the plate floor with a tangent curve.
    clip.moveTo(left, top);
    clip.lineTo(right, top);
    if (left === 0) {
      clip.lineTo(right, plateFloor);
      clip.quadraticCurveTo(turnX, plateFloor, turnX, bottom);
      clip.lineTo(left, bottom);
    } else {
      clip.lineTo(right, bottom);
      clip.lineTo(turnX, bottom);
      clip.quadraticCurveTo(turnX, plateFloor, left, plateFloor);
    }
    clip.closePath();
  }
  return clip;
}

function makePainter(context, Path, avatar, idleImage) {
  const plate = new Path();
  plate.roundRect(plateInset, plateInset, plateSize, plateSize, plateSize * 10 / 44);
  const {x, y, size, motionY, motionOutlets} = avatar.sidebarPlacement;
  let motionClips;

  function paint(image, frame, clip, top) {
    context.clearRect(0, 0, frameSize, frameSize);
    context.save();
    context.clip(clip);
    context.drawImage(image, frame * frameSize, 0, frameSize, frameSize, x, top, size, size);
    context.restore();
  }

  return {
    idle: () => paint(idleImage, 0, plate, y),
    motion(image, frame) {
      motionClips ??= motionOutlets.map(outlets => poseClip(Path, plate, outlets));
      paint(image, frame, motionClips[frame], motionY?.[frame] ?? y);
    },
  };
}

function AvatarImage({src}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className={styles.placeholder} />;
  return <img alt="" className={styles.image} src={src} width={24} height={24}
    draggable={false} onError={() => setFailed(true)} />;
}

export function ChatTeamAvatar({avatar}) {
  return <span className={styles.chat} data-team-avatar={avatar?.id} aria-hidden="true">
    <AvatarImage key={avatar?.chat} src={avatar?.chat} />
  </span>;
}

function SidebarArt({avatar, animated}) {
  const canvas = useRef(null);
  const [fallback, setFallback] = useState(false);
  const [painter, setPainter] = useState(null);

  useLayoutEffect(() => {
    const node = canvas.current;
    const view = node.ownerDocument.defaultView;
    const Path = view?.Path2D;
    const context = Path?.prototype.roundRect && node.getContext("2d");
    if (!context) {
      setFallback(true);
      return;
    }

    let mounted = true;
    void loadImage(view, avatar.foreground).then(image => {
      if (!mounted) return;
      if (image?.naturalWidth !== frameSize || image?.naturalHeight !== frameSize) {
        setFallback(true);
        return;
      }
      const art = makePainter(context, Path, avatar, image);
      art.idle();
      setPainter(art);
    });
    return () => { mounted = false; };
  }, [avatar]);

  useLayoutEffect(() => {
    if (!painter || !animated) return;
    const node = canvas.current;
    const document = node.ownerDocument;
    const view = document.defaultView;
    const preference = view.matchMedia("(prefers-reduced-motion: reduce)");
    const {durations, motionAtlas} = avatar;
    const cycle = durations.reduce((sum, duration) => sum + duration, 0);
    let disposed = false;
    let waiting = false;
    let nextFrame = null;

    function allowed() {
      return !disposed && !preference.matches && !document.hidden && node.isConnected && !node.closest("[inert]");
    }

    function restoreIdle() {
      if (nextFrame !== null) view.cancelAnimationFrame(nextFrame);
      nextFrame = null;
      painter.idle();
    }

    function start(image) {
      let drawn = 0;
      const started = view.performance.now();
      painter.motion(image, drawn);
      if (durations.length === 1) return;

      function tick(now) {
        if (!allowed()) {
          restoreIdle();
          return;
        }
        let elapsed = (now - started) % cycle;
        let frame = 0;
        while (frame < durations.length - 1 && elapsed >= durations[frame]) {
          elapsed -= durations[frame++];
        }
        if (frame !== drawn) {
          painter.motion(image, frame);
          drawn = frame;
        }
        nextFrame = view.requestAnimationFrame(tick);
      }
      nextFrame = view.requestAnimationFrame(tick);
    }

    function sync() {
      if (!allowed()) {
        restoreIdle();
        return;
      }
      if (waiting || nextFrame !== null) return;
      waiting = true;
      void loadImage(view, motionAtlas).then(image => {
        waiting = false;
        if (allowed() && image?.naturalWidth === durations.length * frameSize && image.naturalHeight === frameSize) {
          start(image);
        }
      });
    }

    preference.addEventListener("change", sync);
    sync();
    return () => {
      disposed = true;
      preference.removeEventListener("change", sync);
      restoreIdle();
    };
  }, [animated, avatar, painter]);

  if (fallback) return <AvatarImage src={avatar.chat} />;
  return <canvas ref={canvas} className={styles.art} width={frameSize} height={frameSize} />;
}

export function SidebarTeamAvatar({avatar, animated}) {
  return <span className={styles.sidebar} data-team-avatar={avatar?.id} aria-hidden="true">
    {avatar ? <SidebarArt key={avatar.id} avatar={avatar} animated={animated} /> : <span className={styles.placeholder} />}
  </span>;
}
