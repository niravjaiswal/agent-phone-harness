import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { annotateScreenshot, decodePng, encodePng, fillRect, scalePng } from "../src/core/image.js";
import { finalizeElements } from "../src/core/elements.js";

function solid(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  fillRect(png, { x: 0, y: 0, width, height }, [...rgb, 255]);
  return encodePng(png);
}

const pixel = (png: PNG, x: number, y: number) => {
  const i = (png.width * y + x) << 2;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
};

describe("scalePng", () => {
  it("leaves an image alone when it already fits", () => {
    const png = decodePng(solid(100, 200, [10, 20, 30]));
    const { scale, png: out } = scalePng(png, 500);
    expect(scale).toBe(1);
    expect(out.width).toBe(100);
  });

  it("downscales the long edge and preserves aspect ratio", () => {
    const png = decodePng(solid(1080, 2340, [255, 0, 0]));
    const { png: out } = scalePng(png, 1000);
    expect(out.height).toBe(1000);
    expect(out.width).toBe(Math.round(1080 * (1000 / 2340)));
    expect(pixel(out, 10, 10)).toEqual([255, 0, 0]);
  });
});

describe("annotateScreenshot", () => {
  const els = finalizeElements([
    {
      role: "SecureTextField", label: "Password", bounds: { x: 100, y: 100, width: 200, height: 100 },
      enabled: true, clickable: true, scrollable: false, password: true, depth: 1, childCount: 0,
    },
    {
      role: "Button", text: "Sign in", bounds: { x: 100, y: 400, width: 200, height: 100 },
      enabled: true, clickable: true, scrollable: false, depth: 1, childCount: 0,
    },
  ]);

  it("blacks out password fields", () => {
    const shot = annotateScreenshot(solid(600, 800, [255, 255, 255]), {
      deviceSize: { width: 600, height: 800 },
      redact: els.filter((e) => e.password),
      maxSize: 800,
    });
    const png = decodePng(shot.data);
    expect(pixel(png, 150, 150)).toEqual([0, 0, 0]);
    // Outside the redacted box is untouched.
    expect(pixel(png, 150, 350)).toEqual([255, 255, 255]);
  });

  it("redacts before scaling, so nothing survives the downscale", () => {
    const shot = annotateScreenshot(solid(1200, 1600, [255, 255, 255]), {
      deviceSize: { width: 600, height: 800 },
      redact: els.filter((e) => e.password),
      maxSize: 400,
    });
    const png = decodePng(shot.data);
    expect(png.width).toBe(300);
    // Centre of the (scaled) redacted region.
    const [r, g, b] = pixel(png, Math.round(200 * 0.25), Math.round(150 * 0.25 * 2));
    expect(r! + g! + b!).toBeLessThan(90);
  });

  it("draws numbered marks for interactive elements", () => {
    const plain = annotateScreenshot(solid(600, 800, [255, 255, 255]), {
      deviceSize: { width: 600, height: 800 },
      maxSize: 800,
    });
    const marked = annotateScreenshot(solid(600, 800, [255, 255, 255]), {
      deviceSize: { width: 600, height: 800 },
      marks: els,
      maxSize: 800,
    });
    expect(marked.data.length).not.toBe(plain.data.length);

    const png = decodePng(marked.data);
    // The mark colour appears somewhere on the button's border.
    let found = false;
    for (let y = 395; y < 410 && !found; y++) {
      for (let x = 95; x < 310; x++) {
        const [r, g, b] = pixel(png, x, y);
        if (r! > 200 && g! < 100 && b! < 120) {
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });

  it("maps device points onto image pixels when they differ", () => {
    // 3x device pixel ratio: a 600x800pt screen captured at 1800x2400px.
    const shot = annotateScreenshot(solid(1800, 2400, [255, 255, 255]), {
      deviceSize: { width: 600, height: 800 },
      redact: els.filter((e) => e.password),
      maxSize: 2400,
    });
    const png = decodePng(shot.data);
    // Element at (100,100)-(300,200)pt lands at (300,300)-(900,600)px.
    expect(pixel(png, 500, 400)).toEqual([0, 0, 0]);
    expect(pixel(png, 200, 200)).toEqual([255, 255, 255]);
  });

  it("returns a valid PNG", () => {
    const shot = annotateScreenshot(solid(600, 800, [12, 34, 56]), { marks: els });
    expect(shot.data.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(() => decodePng(shot.data)).not.toThrow();
  });
});
