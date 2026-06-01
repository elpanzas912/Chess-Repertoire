import catalog from "../../data/openings-catalog.json";
import { OpeningsLibrary } from "./openings-library";
import "./openings-library.css";

export default function OpeningsPage() {
  return <OpeningsLibrary openings={catalog.openings} />;
}
