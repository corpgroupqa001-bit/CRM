"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { Camera, MapPin } from "lucide-react";
import { mobilePunch } from "../actions";

// ATT-12: selfie + GPS. The geofence itself is checked in the database.
export function MobilePunch({ cid }: { cid: string }) {
  const [state, action, pending] = useActionState(mobilePunch.bind(null, cid), null);
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shot, setShot] = useState<Blob | null>(null);
  const [pos, setPos] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);
  // the <video> element only exists once a stream is set
  useEffect(() => {
    if (stream && video.current) { video.current.srcObject = stream; video.current.play().catch(() => {}); }
  }, [stream]);
  useEffect(() => { if (state?.ok) { setShot(null); stream?.getTracks().forEach((t) => t.stop()); setStream(null); } }, [state, stream]);

  async function start() {
    setErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      setStream(s);
    } catch { setErr("Camera access was blocked. Allow it in your browser settings."); }
    navigator.geolocation.getCurrentPosition(
      (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      () => setErr("Location access was blocked. Allow it to punch from your phone."),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  function capture() {
    const v = video.current;
    if (!v) return;
    const c = document.createElement("canvas");
    c.width = 480; c.height = Math.round((v.videoHeight / v.videoWidth) * 480) || 360;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => setShot(b), "image/jpeg", 0.75);
  }

  function submit(fd: FormData) {
    if (shot) fd.set("selfie", new File([shot], "selfie.jpg", { type: "image/jpeg" }));
    if (pos) { fd.set("lat", String(pos.lat)); fd.set("lng", String(pos.lng)); }
    action(fd);
  }

  return (
    <div className="space-y-3">
      {!stream ? (
        <button onClick={start} className="btn-primary w-full py-3 text-base"><Camera className="h-5 w-5" /> Punch in / out</button>
      ) : (
        <form action={submit} className="space-y-3">
          <div className="overflow-hidden rounded-xl bg-black">
            <video ref={video} playsInline muted className={`w-full ${shot ? "hidden" : ""}`} />
            {shot && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={URL.createObjectURL(shot)} alt="Selfie" className="w-full" />
            )}
          </div>
          <div className="flex items-center gap-1 text-xs text-slate-500"><MapPin className="h-3.5 w-3.5" />
            {pos ? `Location found (±${pos.acc} m)` : "Finding your location…"}</div>
          <div className="flex gap-2">
            {!shot ? <button type="button" onClick={capture} className="btn-secondary flex-1">Take selfie</button>
              : <button type="button" onClick={() => setShot(null)} className="btn-secondary flex-1">Retake</button>}
            <button className="btn-primary flex-1" disabled={!shot || !pos || pending}>{pending ? "Recording…" : "Record punch"}</button>
          </div>
        </form>
      )}
      {(err || state?.error) && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{err ?? state?.error}</p>}
      {state?.ok && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{state.ok}</p>}
    </div>
  );
}
