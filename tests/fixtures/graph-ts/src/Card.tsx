import { Button } from './Button';
import { formatDate } from './utils';

export interface CardProps {
  title: string;
  onClick: () => void;
  date?: Date;
}

export function Card({ title, onClick, date }: CardProps) {
  return (
    <section>
      <h2>{title}</h2>
      {date ? <time>{formatDate(date)}</time> : null}
      <Button label="Open" onClick={onClick} />
    </section>
  );
}
