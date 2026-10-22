import { Composition, Layer } from 'framefields';

export function createComposition(project) {
  const frames = Math.ceil(project.duration * project.fps);
  const comp = new Composition({
    width: project.width,
    height: project.height,
    fps: project.fps,
    durationFrames: frames,
  });
  const plate = Layer.video(project.source, {
    startFrame: 0,
    durationFrames: frames,
    trimStartSec: project.trim_start,
    fit: 'cover',
    muted: false,
  });
  const content = [];
  for (const caption of project.captions) {
    content.push(
      Layer.text(caption.text, {
        startFrame: Math.round(caption.start * project.fps),
        durationFrames: Math.max(1, Math.round((caption.end - caption.start) * project.fps)),
        x: '50%',
        y: '85%',
        fontSize: 40,
        fill: '#ffffff',
      }),
    );
  }
  const sourceWidth = project.source_width ?? project.width;
  const sourceHeight = project.source_height ?? project.height;
  const scale = Math.max(project.width / sourceWidth, project.height / sourceHeight);
  const position = point => ({
    x: point.x * sourceWidth * scale + (project.width - sourceWidth * scale) / 2,
    y: point.y * sourceHeight * scale + (project.height - sourceHeight * scale) / 2,
  });
  for (const overlay of project.overlays) {
    const node = Layer.text(overlay.label, {
      startFrame: Math.round(overlay.start * project.fps),
      durationFrames: Math.max(1, Math.round((overlay.end - overlay.start) * project.fps)),
      ...position(overlay),
      fontSize: 28,
      fill: '#ffff00',
    });
    content.push(node);
    const points = overlay.keyframes;
    if (points?.length) {
      comp.onRequestFrame(ctx => {
        const time = ctx.frame / project.fps;
        let left = points[0];
        let right = points.at(-1);
        for (const point of points) {
          if (point.time <= time) {
            left = point;
          }
          if (point.time >= time) {
            right = point;
            break;
          }
        }
        const factor =
          right.time === left.time ? 0 : Math.max(0, Math.min(1, (time - left.time) / (right.time - left.time)));
        const location = position({ x: left.x + (right.x - left.x) * factor, y: left.y + (right.y - left.y) * factor });
        node.x = location.x;
        node.y = location.y;
      });
    }
  }
  if (project.subject_matte) {
    comp.addSubjectSandwich({ source: plate, behind: content, fit: 'cover' });
  } else {
    comp.add(plate);
    for (const node of content) {
      comp.add(node);
    }
  }
  if (project.narration) {
    comp.add(Layer.audio(project.narration, { startFrame: 0, durationFrames: frames }));
  }
  return comp;
}
