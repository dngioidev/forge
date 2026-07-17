export interface ButtonProps {
  label: string;
  onClick: () => void;
  variant?: 'primary' | 'ghost';
}

export function Button({ label, onClick, variant = 'primary' }: ButtonProps) {
  return (
    <button className={`btn btn--${variant}`} onClick={onClick}>
      {label}
    </button>
  );
}
