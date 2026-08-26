import type { ButtonHTMLAttributes } from 'react';
import styles from './IconButton.module.css';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
  buttonSize?: 'sm' | 'md' | 'lg';
  variant?: 'ghost' | 'surface' | 'brand';
  shape?: 'circle' | 'rounded';
}

export function IconButton({
  children,
  buttonSize = 'md',
  variant = 'ghost',
  shape = 'rounded',
  className = '',
  type = 'button',
  ...rest
}: IconButtonProps) {
  const classes = [
    styles.iconButton,
    styles[buttonSize],
    styles[variant],
    styles[shape],
    className,
  ].join(' ');

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
