import { FigurePlace } from "./Figure";

/** A figure's place with nothing to show in it, for a figure made of more than one number ("0.08 TAO $20.00"): the
 * skeleton while it loads (Figure.tsx), "–" once its read finished without a value; each read out as what it means. */
export function Dash({ loading }: { loading: boolean }) {
  return <FigurePlace loading={loading} />;
}
