"use client";
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

/** Password field with a show / hide toggle. Takes the same props as an <input>; the type is managed here. */
export function PasswordInput({ className = "", ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="relative block">
      <input {...props} type={visible ? "text" : "password"} className={`input pr-10 ${className}`} />
      <button type="button" onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"} aria-pressed={visible} title={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-slate-400 hover:text-slate-600 focus-visible:text-slate-700 focus-visible:outline-none">
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </span>
  );
}
