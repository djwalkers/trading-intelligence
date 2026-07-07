interface StarRatingProps {
  score: number;
  outOf?: number;
}

export function StarRating({ score, outOf = 5 }: StarRatingProps) {
  return (
    <div className="flex items-center gap-0.5" aria-label={`${score} out of ${outOf}`}>
      {Array.from({ length: outOf }).map((_, index) => (
        <span
          key={index}
          className={index < score ? "text-ink-100" : "text-base-600"}
          aria-hidden="true"
        >
          ★
        </span>
      ))}
    </div>
  );
}
