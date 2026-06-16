"use client";

import { getFlag } from "@/lib/players";
import { getUserLabel, USER_COLORS } from "@/lib/users";

type PlayerCardProps = {
  playerKey: string;
  displayName: string;
  role: string;
  teamCode: string;
  efppm: number;
  takenBy: string | null;
  isMyPick?: boolean;
  isSelected?: boolean;
  isCaptain?: boolean;
  isViceCaptain?: boolean;
  isMyTurn?: boolean;
  onClick?: () => void;
  onCaptainClick?: () => void;
  onViceCaptainClick?: () => void;
  compact?: boolean;
};

const ROLE_COLORS: Record<string, string> = {
  WK: "bg-yellow-600",
  BAT: "bg-blue-600",
  AR: "bg-purple-600",
  BOWL: "bg-red-600",
};

export default function PlayerCard({
  playerKey,
  displayName,
  role,
  teamCode,
  efppm,
  takenBy,
  isMyPick = false,
  isSelected = false,
  isCaptain = false,
  isViceCaptain = false,
  isMyTurn = false,
  onClick,
  onCaptainClick,
  onViceCaptainClick,
  compact = false,
}: PlayerCardProps) {
  const isTaken = !!takenBy;
  const canClick = !isTaken && isMyTurn && onClick;

  const ringClass = isCaptain
    ? "ring-2 ring-yellow-400"
    : isViceCaptain
    ? "ring-2 ring-blue-400"
    : isSelected
    ? "ring-2 ring-emerald-500"
    : isMyPick
    ? "ring-1 ring-blue-500"
    : "";

  const bgClass = isTaken
    ? "bg-zinc-800 opacity-60"
    : isSelected || isMyPick
    ? "bg-zinc-800"
    : "bg-zinc-900 hover:bg-zinc-800";

  const takerColor =
    takenBy && USER_COLORS[takenBy] ? USER_COLORS[takenBy] : "bg-gray-500";

  return (
    <div
      onClick={canClick ? onClick : undefined}
      className={`relative rounded-xl px-3 py-2 transition-all ${bgClass} ${ringClass} ${
        canClick ? "cursor-pointer active:scale-95" : ""
      } ${compact ? "py-2" : "py-3"}`}
    >
      <div className="flex items-center gap-2">
        {/* Flag + role */}
        <span className="text-lg">{getFlag(teamCode)}</span>
        <span
          className={`text-xs font-bold px-1.5 py-0.5 rounded ${
            ROLE_COLORS[role] ?? "bg-zinc-600"
          }`}
        >
          {role}
        </span>

        {/* Name */}
        <span
          className={`flex-1 font-semibold text-sm ${
            isTaken ? "text-zinc-500" : "text-white"
          }`}
        >
          {displayName}
        </span>

        {/* Points */}
        {!compact && (
          <span className="text-emerald-400 font-bold text-sm">
            {efppm.toFixed(0)}
            <span className="text-zinc-500 font-normal text-xs"> pts</span>
          </span>
        )}

        {/* C/VC buttons */}
        {(onCaptainClick || onViceCaptainClick) && (
          <div className="flex gap-1">
            {onCaptainClick && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onCaptainClick();
                }}
                className={`text-xs px-1.5 py-0.5 rounded font-bold transition-colors ${
                  isCaptain
                    ? "bg-yellow-500 text-black"
                    : "bg-zinc-700 hover:bg-yellow-600 text-white"
                }`}
              >
                C
              </button>
            )}
            {onViceCaptainClick && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViceCaptainClick();
                }}
                className={`text-xs px-1.5 py-0.5 rounded font-bold transition-colors ${
                  isViceCaptain
                    ? "bg-blue-500 text-white"
                    : "bg-zinc-700 hover:bg-blue-600 text-white"
                }`}
              >
                VC
              </button>
            )}
          </div>
        )}
      </div>

      {/* Taken badge */}
      {takenBy && (
        <div className="mt-1 flex items-center gap-1">
          <span className={`w-2 h-2 rounded-full ${takerColor}`} />
          <span className="text-xs text-zinc-400">
            {getUserLabel(takenBy)}
          </span>
        </div>
      )}

      {/* C/VC badge overlay */}
      {(isCaptain || isViceCaptain) && (
        <span
          className={`absolute top-1 right-1 text-xs font-bold px-1 rounded ${
            isCaptain ? "bg-yellow-500 text-black" : "bg-blue-500 text-white"
          }`}
        >
          {isCaptain ? "C" : "VC"}
        </span>
      )}
    </div>
  );
}
