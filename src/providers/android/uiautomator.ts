import { XMLParser } from "fast-xml-parser";
import type { RawElement } from "../../core/elements.js";
import type { Rect } from "../../core/types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => name === "node",
});

/** bounds="[0,84][1080,2340]" */
export function parseBounds(v: string | undefined): Rect | null {
  if (!v) return null;
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(v);
  if (!m) return null;
  const x1 = Number(m[1]);
  const y1 = Number(m[2]);
  const x2 = Number(m[3]);
  const y2 = Number(m[4]);
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

const ROLE_MAP: [RegExp, string][] = [
  [/EditText|AutoCompleteTextView|SearchView/, "TextField"],
  [/Button|ImageButton|MaterialButton/, "Button"],
  [/CheckBox|CheckedTextView/, "Checkbox"],
  [/RadioButton/, "Radio"],
  [/Switch|ToggleButton/, "Switch"],
  [/SeekBar|Slider/, "Slider"],
  [/Spinner|NumberPicker|DatePicker|TimePicker/, "Picker"],
  [/RecyclerView|ListView|GridView|ScrollView|NestedScrollView|ViewPager|HorizontalScrollView/, "List"],
  [/TabWidget|TabLayout/, "TabBar"],
  [/Toolbar|ActionBar|AppBarLayout/, "Toolbar"],
  [/WebView/, "WebView"],
  [/ImageView|ImageSwitcher/, "Image"],
  [/TextView/, "Text"],
  [/Layout|ViewGroup|View$/, "Group"],
];

export function roleFromClass(cls: string | undefined, contentDesc?: string): string {
  const c = cls ?? "";
  for (const [re, role] of ROLE_MAP) if (re.test(c)) return role;
  if (contentDesc) return "Other";
  const short = c.split(".").pop();
  return short && short.length < 24 ? short : "Other";
}

const bool = (v: unknown) => v === "true" || v === true;

interface XmlNode {
  "@text"?: string;
  "@class"?: string;
  "@package"?: string;
  "@content-desc"?: string;
  "@resource-id"?: string;
  "@bounds"?: string;
  "@checkable"?: string;
  "@checked"?: string;
  "@clickable"?: string;
  "@enabled"?: string;
  "@focused"?: string;
  "@scrollable"?: string;
  "@long-clickable"?: string;
  "@password"?: string;
  "@selected"?: string;
  node?: XmlNode[];
}

export interface ParsedDump {
  elements: RawElement[];
  /** Foreground package inferred from the dump, when dumpsys is unavailable. */
  pkg?: string;
  rootBounds?: Rect;
}

/**
 * Parse a `uiautomator dump` XML into raw elements.
 *
 * Runs unfiltered — pruning happens centrally in the element layer so every
 * provider prunes identically.
 */
export function parseUiAutomatorXml(xml: string): ParsedDump {
  const doc = parser.parse(xml) as { hierarchy?: XmlNode };
  const root = doc.hierarchy;
  const elements: RawElement[] = [];
  let pkg: string | undefined;
  let rootBounds: Rect | undefined;

  const walk = (node: XmlNode, depth: number) => {
    const bounds = parseBounds(node["@bounds"]);
    const children = node.node ?? [];
    if (bounds) {
      if (!rootBounds) rootBounds = bounds;
      const cls = node["@class"];
      const desc = node["@content-desc"]?.trim() || undefined;
      const text = node["@text"]?.trim() || undefined;
      const id = node["@resource-id"]?.trim() || undefined;
      const isField = /EditText|AutoComplete|SearchView/.test(cls ?? "");
      if (!pkg && node["@package"]) pkg = node["@package"];
      elements.push({
        role: roleFromClass(cls, desc),
        text,
        label: desc,
        value: isField ? text : undefined,
        id,
        bounds,
        enabled: node["@enabled"] === undefined ? true : bool(node["@enabled"]),
        clickable: bool(node["@clickable"]) || bool(node["@long-clickable"]),
        scrollable: bool(node["@scrollable"]),
        focused: bool(node["@focused"]) || undefined,
        selected: bool(node["@selected"]) || undefined,
        checked: bool(node["@checkable"]) ? bool(node["@checked"]) : undefined,
        password: bool(node["@password"]) || undefined,
        depth,
        pkg: node["@package"],
        childCount: children.length,
      });
    }
    for (const c of children) walk(c, depth + 1);
  };

  for (const c of root?.node ?? []) walk(c, 0);
  return { elements, pkg, rootBounds };
}
