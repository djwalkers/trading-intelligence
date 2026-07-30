import { PortfolioView } from "@/components/portfolio/PortfolioView";
import { paperPortfolio } from "@/lib/mock";

export const metadata = {
  title: "Local Paper Simulation | Trading Intelligence Platform",
};

export default function PaperPortfolioPage() {
  return <PortfolioView paperPortfolio={paperPortfolio} />;
}
