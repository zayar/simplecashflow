export type User = {
  id: number;
  email: string;
  name: string | null;
  companyId: number;
  role: string;
};

export type AuthResponse = {
  token: string;
  user: User;
};


