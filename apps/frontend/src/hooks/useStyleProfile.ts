// hooks/useStyleProfile.ts
import {useQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {apiClient} from '../lib/apiClient';

export function useStyleProfile(userId: string) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['styleProfile'],
    enabled: !!userId,
    queryFn: async () => {
      const response = await apiClient.get('/style-profile');
      return response.data;
    },
  });

  const mutation = useMutation({
    mutationFn: async (updatedProfile: any) => {
      const response = await apiClient.put('/style-profile', updatedProfile);
      return response.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['styleProfile'], data);
      queryClient.invalidateQueries({queryKey: ['styleProfile']});
      queryClient.invalidateQueries({queryKey: ['favoriteBrands']});
    },
  });

  const updateProfile = (field: string, value: any) => {
    // Just send the single field update - backend handles UPSERT correctly
    mutation.mutate({ [field]: value });
  };

  const updateProfileAsync = (field: string, value: any) => {
    return mutation.mutateAsync({ [field]: value });
  };

  return {
    styleProfile: queryClient.getQueryData(['styleProfile']) ?? query.data,
    updateProfile,
    updateProfileAsync,
    refetch: query.refetch,
    isLoading: query.isLoading,
    isUpdating: mutation.isPending,
    isError: query.isError,
  };
}
