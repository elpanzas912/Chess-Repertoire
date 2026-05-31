import { notFound } from "next/navigation";
import catalog from "../../../data/openings-catalog.json";
import { OpeningTrainer } from "../../openings/[slug]/opening-trainer";

export default async function OpeningPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!(slug in catalog.openings)) notFound();
  return <OpeningTrainer slug={slug} />;
}
