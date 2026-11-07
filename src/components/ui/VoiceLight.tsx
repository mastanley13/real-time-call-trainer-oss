"use client";

import { useEffect, useRef, useState } from "react";

/** What the light shows at one moment. level 0..1 is loudness; turbulence 0..1 how restless the edge is; pulse a beat. */
export interface LightLevel { level: number; turbulence?: number; pulse?: number; listening?: boolean }

/**
 * The caller's voice as warm light on the night stage (Stage and Desk). A small WebGL shader draws a soft sphere whose
 * size and edge follow `getLevel`, read every frame: the persona's audio level on a voice call, a scripted rhythm on a
 * text call. It dims while the trainee talks. Decorative only (aria-hidden unless `label` is given). Its three colors are
 * the --light-candle, --light-gold and --light-deep tokens in globals.css, read once when the light starts.
 *
 * Falls back to a CSS glow when WebGL is unavailable, and to a still frame for reduced motion. The noise is the standard
 * 3D simplex noise by Ian McEwan and Ashima Arts (MIT). No external dependency. Shared with the USMC copy's Stage Light.
 */
const VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
const FRAG = `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_level;
uniform float u_turb;
uniform float u_pulse;
uniform float u_dim;
uniform vec3 u_candle;
uniform vec3 u_gold;
uniform vec3 u_deep;
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_res) / min(u_res.x, u_res.y);
  float r = length(uv);
  float a = atan(uv.y, uv.x);
  vec2 dir = vec2(cos(a), sin(a));
  float t = u_time * 0.32;
  float n1 = snoise(vec3(dir * 0.8, t));
  float n2 = snoise(vec3(dir * 1.6 + 3.1, t * 1.6));
  float wob = n1 * 0.65 + n2 * 0.35 * (0.3 + u_turb);
  float base = 0.17 + 0.08 * u_level + 0.035 * u_pulse;
  float edge = base + wob * (0.006 + 0.024 * u_level * (0.4 + u_turb));
  float inside = smoothstep(edge + 0.02, edge - 0.02, r);
  vec2 hot = vec2(snoise(vec3(t * 0.6, 1.0, 2.0)), snoise(vec3(4.0, t * 0.6, 1.0))) * 0.05;
  float d = length(uv - hot) / max(edge, 0.001);
  float swirl = snoise(vec3(uv * 6.5, t * 1.5)) * 0.5 + 0.5;
  vec3 deep = u_deep;
  vec3 gold = u_gold;
  vec3 candle = u_candle;
  vec3 col = mix(gold, deep, smoothstep(0.62, 1.05, d));
  col = mix(candle, col, smoothstep(0.0, 0.6 + 0.25 * u_level, d));
  col += (swirl - 0.5) * 0.07 * (0.35 + u_level);
  col = clamp(col, 0.0, 1.0);
  float outD = max(r - edge, 0.0);
  float halo = exp(-outD * (10.0 - 5.0 * u_level)) * (0.28 + 0.72 * u_level);
  float rim = exp(-outD * 30.0) * 0.55;
  float hA = clamp(halo * 0.55 + rim * 0.5, 0.0, 1.0) * (1.0 - inside) * smoothstep(0.5, 0.34, r);
  vec3 hC = mix(gold, deep, 0.4);
  float dim = 1.0 - 0.45 * u_dim;
  vec3 rgb = (col * inside + hC * hA) * dim;
  float alpha = (inside + hA) * dim;
  float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  rgb = clamp(rgb + (g - 0.5) * 0.025 * alpha, 0.0, 1.0);
  gl_FragColor = vec4(min(rgb, vec3(alpha)), alpha);
}`;

/** A token from globals.css (an RGB triplet such as "255 184 92") as 0..1 channels, read where the light sits. */
function tokenRgb(el: Element, name: string): [number, number, number] {
  const parts = getComputedStyle(el).getPropertyValue(name).trim().split(/\s+/).map(Number);
  return parts.length === 3 && parts.every((n) => Number.isFinite(n)) ? [parts[0] / 255, parts[1] / 255, parts[2] / 255] : [1, 1, 1];
}

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
}

/** A calm idle rhythm: the light breathes while nobody speaks. */
export const idleLevel = (t: number): LightLevel => ({ level: 0.13 + 0.06 * Math.max(0, Math.sin(t * 2.4)), turbulence: 0.3 });
/** A speech-like rhythm for a text call while the caller's reply is "spoken". */
export const talkLevel = (t: number): LightLevel => ({ level: 0.85 * (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 11.3) * Math.sin(t * 4.7 + 1.3))), turbulence: 0.9 });

export default function VoiceLight({ getLevel, label, className = "" }: { getLevel: (t: number) => LightLevel; label?: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);
  const levelRef = useRef(getLevel);
  levelRef.current = getLevel;
  const [mode, setMode] = useState<"webgl" | "css">("webgl");

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const canvas = canvasRef.current;
    let gl: WebGLRenderingContext | null = null;
    try { gl = canvas ? (canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true }) as WebGLRenderingContext | null) : null; } catch { gl = null; }
    const state = { level: 0.15, turb: 0.3, pulse: 0, dim: 0 };
    const step = (t: number) => {
      const want = levelRef.current(t);
      const k = reduce ? 1 : 0.16;
      state.level += (want.level - state.level) * k;
      state.turb += ((want.turbulence ?? 0.3) - state.turb) * 0.05;
      state.pulse = want.pulse ?? 0;
      state.dim += ((want.listening ? 1 : 0) - state.dim) * 0.08;
      if (reduce) state.level = Math.round(state.level * 3) / 3;
    };
    let raf = 0;
    // No WebGL (or the shader did not compile): a CSS glow that scales with the same level.
    const css = () => {
      setMode("css");
      const tick = (ms: number) => {
        step(ms / 1000);
        const el = glowRef.current;
        if (el) { el.style.transform = `scale(${0.82 + state.level * 0.28 + state.pulse * 0.06})`; el.style.opacity = String(1 - 0.45 * state.dim); }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(raf);
    };
    if (!gl) return css();
    const vs = compile(gl, gl.VERTEX_SHADER, VERT), fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return css();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (n: string) => gl!.getUniformLocation(prog, n);
    const U = { res: u("u_res"), time: u("u_time"), level: u("u_level"), turb: u("u_turb"), pulse: u("u_pulse"), dim: u("u_dim") };
    gl.uniform3fv(u("u_candle"), tokenRgb(canvas!, "--light-candle"));
    gl.uniform3fv(u("u_gold"), tokenRgb(canvas!, "--light-gold"));
    gl.uniform3fv(u("u_deep"), tokenRgb(canvas!, "--light-deep"));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const start = performance.now();
    const frame = (ms: number) => {
      const g = gl!;
      step(ms / 1000);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(canvas!.clientWidth * dpr), h = Math.round(canvas!.clientHeight * dpr);
      if (w && h && (canvas!.width !== w || canvas!.height !== h)) { canvas!.width = w; canvas!.height = h; }
      g.viewport(0, 0, canvas!.width, canvas!.height);
      g.clearColor(0, 0, 0, 0);
      g.clear(g.COLOR_BUFFER_BIT);
      g.uniform2f(U.res, canvas!.width, canvas!.height);
      g.uniform1f(U.time, reduce ? 3 : (ms - start) / 1000);
      g.uniform1f(U.level, state.level);
      g.uniform1f(U.turb, state.turb);
      g.uniform1f(U.pulse, reduce ? 0 : state.pulse);
      g.uniform1f(U.dim, state.dim);
      g.drawArrays(g.TRIANGLES, 0, 6);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <div className={`relative grid place-items-center ${className}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {mode === "webgl" ? (
        <canvas ref={canvasRef} className="block h-full w-full" />
      ) : (
        <span ref={glowRef} className="block h-[52%] w-[52%] rounded-full shadow-[0_0_60px_20px_rgb(var(--light-gold)/0.25)]"
          style={{ background: "radial-gradient(circle, rgb(var(--light-candle)) 0 22%, rgb(var(--light-gold)) 46%, rgb(var(--light-deep) / 0.25) 70%, transparent 74%)" }} />
      )}
    </div>
  );
}
