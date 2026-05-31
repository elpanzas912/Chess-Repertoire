import catalog from "../../data/openings-catalog.json";
import { OpeningsLibrary } from "./openings-library";

export default function OpeningsPage() {
  return <OpeningsLibrary openings={catalog.openings} />;
}
